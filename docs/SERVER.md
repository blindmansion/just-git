# Server

Embeddable Git server with Smart HTTP and SSH support. Any standard git client (`git`, VS Code, GitHub Desktop) can clone from, fetch from, and push to repos served by just-git.

HTTP uses web-standard `Request`/`Response` — works with Bun, Hono, Cloudflare Workers, Deno, or any fetch-compatible runtime. SSH uses web-standard `ReadableStream`/`WritableStream` — works with any SSH library through a thin adapter. For Node.js's `http.createServer`, use `server.nodeHandler`.

```ts
import { createServer } from "just-git/server";
```

## Quick start

Storage defaults to in-memory — no setup required:

```ts
import { createServer } from "just-git/server";

const server = createServer({ autoCreate: true });
Bun.serve({ fetch: server.fetch });
// git clone http://localhost:3000/my-repo ← works immediately
```

For persistent storage, pass a SQLite or Postgres backend:

```ts
import { createServer, BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteStorage(new Database("repos.sqlite")),
});

await server.createRepo("my-repo");
Bun.serve({ fetch: server.fetch });
```

For Node.js, use `server.nodeHandler`:

```ts
import http from "node:http";
import { createServer, BetterSqlite3Storage } from "just-git/server";
import Database from "better-sqlite3";

const server = createServer({
  storage: new BetterSqlite3Storage(new Database("repos.sqlite")),
});

await server.createRepo("my-repo");
http.createServer(server.nodeHandler).listen(3000);
```

Clients can clone, fetch, and push:

```bash
git clone http://localhost:3000/my-repo
```

## Repo management

The server manages repos through three methods:

| Method                     | Returns           | Description                                          |
| -------------------------- | ----------------- | ---------------------------------------------------- |
| `createRepo(id, options?)` | `GitRepo`         | Create a repo and initialize HEAD. Throws if exists. |
| `repo(id)`                 | `GitRepo \| null` | Get a repo, or `null` if it hasn't been created.     |
| `requireRepo(id)`          | `GitRepo`         | Get a repo, or throw if it doesn't exist.            |
| `deleteRepo(id)`           | `void`            | Delete all data and the repo record.                 |

### Garbage collection

`server.gc(repoId)` removes unreachable objects from storage — objects not reachable from any ref. Typical sources of unreachable objects are force-pushed-away commits, deleted branches, and objects ingested from rejected pushes.

```ts
const result = await server.gc("my-repo");
// result: { deleted: 12, retained: 847 }
```

Use `dryRun` to preview what would be deleted without actually deleting:

```ts
const result = await server.gc("my-repo", { dryRun: true });
console.log(`Would delete ${result.deleted} objects`);
```

If refs change during the walk (e.g. a concurrent push completes), GC aborts and returns `{ aborted: true }` instead of risking deletion of newly-reachable objects. Callers can retry.

```ts
const result = await server.gc("my-repo");
if (result.aborted) {
  // refs changed during GC — retry later
}
```

By default, requests to unknown repos return 404 (HTTP) or exit 128 (SSH). Set `autoCreate` to create repos on first access (e.g. for a push-to-create workflow):

```ts
const server = createServer({
  autoCreate: true, // or { defaultBranch: "main" }
});
```

The optional `resolve` callback maps a request path to a repo ID. The default is identity — the URL path segment is the repo ID. For `http://host/org/project/info/refs`, the repo ID is `"org/project"`. For SSH `git-upload-pack '/org/project'`, it's `"org/project"`.

A request 404s if `resolve` returns `null` (bad path) or if the resolved ID doesn't match an existing repo (and `autoCreate` is off). Both cases produce the same response.

```ts
const server = createServer({
  storage: new BunSqliteStorage(db),
  resolve: (path) => {
    if (!path.startsWith("repos/")) return null; // 404
    return path.slice("repos/".length);
  },
});
```

## Authorization

### Session builder

The optional `session` config builds a typed session object from each request. The session is available in all hooks. For HTTP, returning a `Response` rejects the request (e.g. 401). For SSH, auth is handled at the transport layer before the session builder runs.

```ts
const server = createServer({
  storage: new BunSqliteStorage(db),
  session: {
    http: (request) => {
      const header = request.headers.get("Authorization");
      if (!header) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="git"' },
        });
      }
      return { userId: parseToken(header) };
    },
    ssh: (info) => ({ userId: info.username ?? "anonymous" }),
  },
  hooks: {
    preReceive: ({ session }) => {
      if (!session) return { reject: true, message: "unauthorized" };
    },
  },
});
```

When `session` is omitted, the server uses a default `Session` type with `transport`, optional `username`, and optional `request`.

### Public read, private write

Anyone can clone, only authorized users can push:

```ts
const server = createServer({
  storage: new BunSqliteStorage(db),
  hooks: {
    preReceive: ({ session }) => {
      if (!session?.request?.headers.has("Authorization"))
        return { reject: true, message: "unauthorized" };
    },
  },
});
```

With a custom session type, auth works uniformly across HTTP and SSH:

```ts
const server = createServer({
  storage: new BunSqliteStorage(db),
  session: {
    http: (req) => ({ authorized: req.headers.has("Authorization") }),
    ssh: (info) => ({ authorized: info.username != null }),
  },
  hooks: {
    preReceive: ({ session }) => {
      if (!session?.authorized) return { reject: true, message: "unauthorized" };
    },
  },
});
```

## SSH

`server.handleSession` handles git-over-SSH. Call it when the SSH client execs a git command. Returns the exit code to send to the client.

```ts
import { Server } from "ssh2";
import { createServer, BunSqliteStorage, type SshChannel } from "just-git/server";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteStorage(new Database("repos.sqlite")),
});
await server.createRepo("my-repo");

new Server({ hostKeys: [hostKey] }, (client) => {
  let username: string | undefined;
  client.on("authentication", (ctx) => {
    username = ctx.username;
    ctx.accept();
  });
  client.on("session", (accept) => {
    accept().on("exec", (accept, reject, info) => {
      const stream = accept();
      const channel: SshChannel = {
        readable: new ReadableStream({
          start(c) {
            stream.on("data", (d: Buffer) => c.enqueue(new Uint8Array(d)));
            stream.on("end", () => c.close());
          },
        }),
        writable: new WritableStream({
          write(chunk) {
            stream.write(chunk);
          },
        }),
        writeStderr(data) {
          stream.stderr.write(data);
        },
      };
      server.handleSession(info.command, channel, { username }).then((code) => {
        stream.exit(code);
        stream.close();
      });
    });
  });
}).listen(2222);
```

`handleSession` takes an optional `SshSessionInfo` with `username` and a `metadata` bag for passing along SSH-layer details (key fingerprint, client IP, etc.) — the session builder can extract and type these.

> **Protocol version:** Both protocol v1 and v2 are supported over HTTP and SSH. Protocol v2 is used for upload-pack (`fetch`/`clone`) when the client requests it via `GIT_PROTOCOL_VERSION=2` or the `git-protocol` header. Receive-pack (`push`) always uses v1.

## Policy

Declarative push rules that run before hooks. These are git-level constraints that don't depend on the session — for auth logic, use [hooks](#hooks).

```ts
const server = createServer({
  storage: new BunSqliteStorage(db),
  policy: {
    protectedBranches: ["main", "production"],
    denyNonFastForward: true,
    denyDeletes: true,
    immutableTags: true,
  },
});
```

| Option               | Effect                                               |
| -------------------- | ---------------------------------------------------- |
| `protectedBranches`  | Listed branches cannot be force-pushed to or deleted |
| `denyNonFastForward` | Reject all non-fast-forward pushes globally          |
| `denyDeletes`        | Reject all ref deletions globally                    |
| `immutableTags`      | Tags are immutable — no deletion, no overwrite       |

Policy rules are checked first. If a policy check rejects, user hooks don't run.

## Hooks

Server hooks fire during push and ref advertisement. All are optional.

```ts
const server = createServer({
  storage: new BunSqliteStorage(db),
  hooks: {
    preReceive: async ({ repo, updates, session }) => {
      if (!session?.request?.headers.has("Authorization"))
        return { reject: true, message: "unauthorized" };
    },

    update: async ({ repo, update }) => {
      if (update.ref === "refs/heads/main" && !update.isFF && !update.isCreate) {
        return { reject: true, message: "non-fast-forward to main" };
      }
    },

    postReceive: async ({ repo, repoId, updates }) => {
      for (const u of updates) {
        const files = await getChangedFiles(repo, u.oldHash, u.newHash);
        console.log(`${repoId}: ${u.ref} updated, ${files.length} files changed`);
      }
    },

    advertiseRefs: async ({ refs, repoId, session }) => {
      if (isPrivateRepo(repoId) && !session?.token) {
        return { reject: true, message: "authentication required" };
      }
      return refs.filter((r) => !r.name.startsWith("refs/internal/"));
    },
  },
});
```

| Hook            | Fires when                                         | Can reject?                |
| --------------- | -------------------------------------------------- | -------------------------- |
| `preReceive`    | After objects are unpacked, before any ref updates | Yes (aborts entire push)   |
| `update`        | Per-ref, after `preReceive` passes                 | Yes (blocks this ref only) |
| `postReceive`   | After all ref updates succeed                      | No                         |
| `advertiseRefs` | Client requests ref listing (clone/fetch/push)     | Yes (denies repo access)   |

All hook payloads include `repo: GitRepo`, `repoId` (the resolved repo ID), and `session`. Pre-hooks return `{ reject: true, message? }` to block the operation, using the same `Rejection` protocol as [client-side hooks](HOOKS.md).

### Composing hooks

Combine multiple hook sets with `composeHooks()`. Pre-hooks chain in order and short-circuit on the first rejection. Post-hooks all run regardless.

All composed hook sets must share the same session type `S`. For reusable hooks that don't inspect the session, use `ServerHooks<unknown>` — it composes with any concrete session type thanks to contravariance.

```ts
import { createServer, composeHooks } from "just-git/server";

const server = createServer({
  storage: new BunSqliteStorage(db),
  hooks: composeHooks(auditHooks, ciTriggerHooks),
});
```

## Storage backends

Storage defaults to `MemoryStorage` when omitted. Pass a `Storage` to the server via `storage` for persistence. Multiple repos are partitioned by ID in a single store. Drivers also work with `resolveRemote` for in-process cross-VFS transport alongside HTTP access (use `server.repo(id)` or the throwing `server.requireRepo(id)` to get the `GitRepo`).

### `MemoryStorage`

The default. Data lives in-process and is lost when the process exits. Useful for tests, ephemeral servers, and prototyping.

```ts
import { createServer, MemoryStorage } from "just-git/server";

// These are equivalent:
const server = createServer();
const server2 = createServer({ storage: new MemoryStorage() });
```

### `BunSqliteStorage`

For Bun. Takes a `bun:sqlite` `Database` directly.

```ts
import { createServer, BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteStorage(new Database("repos.sqlite")),
});
await server.createRepo("my-repo");
```

### `BetterSqlite3Storage`

For Node.js. Takes a `better-sqlite3` `Database` directly.

```ts
import { createServer, BetterSqlite3Storage } from "just-git/server";
import Database from "better-sqlite3";

const server = createServer({
  storage: new BetterSqlite3Storage(new Database("repos.sqlite")),
});
await server.createRepo("my-repo");
```

### `PgStorage`

Takes a `pg`-style pool directly. `PgStorage.create()` is async (runs schema setup). The `PgPool` interface is duck-typed — any object with `query()` and `connect()` methods works.

```ts
import { createServer, PgStorage } from "just-git/server";
import { Pool } from "pg";

const server = createServer({
  storage: await PgStorage.create(new Pool({ connectionString: process.env.DATABASE_URL })),
});
await server.createRepo("my-repo");
```

### Database schema

The SQL backends (`BunSqliteStorage`, `BetterSqlite3Storage`, `PgStorage`) create three tables on the provided database if they don't already exist:

| Table         | Purpose                                       | Key                |
| ------------- | --------------------------------------------- | ------------------ |
| `git_repos`   | Repo registry, one row per repo ID            | `id` (primary key) |
| `git_objects` | Raw git objects (blobs, trees, commits, tags) | `(repo_id, hash)`  |
| `git_refs`    | Refs (branches, tags, HEAD, symrefs)          | `(repo_id, name)`  |

All tables are partitioned by `repo_id`. The library only references the `id` column on `git_repos`, so you can safely add your own columns (owner, description, visibility, etc.). Just make sure they're nullable or have defaults, since `createRepo` inserts with `id` only.

### Custom storage

Implement the `Storage` interface to back repos with any datastore — DynamoDB, Turso, Firestore, a REST API, etc. The interface is intentionally thin: raw key-value CRUD for objects and refs, plus one atomicity primitive. All git-aware logic (object hashing, pack ingestion, symref resolution, compare-and-swap) is handled by the adapter layer — your implementation doesn't need to know anything about git.

```ts
import type { Storage } from "just-git/server";

class MyStorage implements Storage {
  // Repo lifecycle
  hasRepo(repoId: string) {
    /* ... */
  }
  insertRepo(repoId: string) {
    /* ... */
  }
  deleteRepo(repoId: string) {
    /* ... */
  }

  // Objects — keyed by (repoId, hash)
  getObject(repoId, hash) {
    /* return { type, content } or null */
  }
  putObject(repoId, hash, type, content) {
    /* upsert, ignore duplicates */
  }
  putObjects(repoId, objects) {
    /* batch insert — use a transaction if available */
  }
  hasObject(repoId, hash) {
    /* existence check */
  }
  findObjectsByPrefix(repoId, prefix) {
    /* for short-hash resolution */
  }
  listObjectHashes(repoId) {
    /* all hashes — used by GC */
  }
  deleteObjects(repoId, hashes) {
    /* bulk delete — used by GC */
  }

  // Refs — keyed by (repoId, name)
  getRef(repoId, name) {
    /* return Ref or null */
  }
  putRef(repoId, name, ref) {
    /* upsert */
  }
  removeRef(repoId, name) {
    /* delete */
  }
  listRefs(repoId, prefix?) {
    /* list, optionally filtered by prefix */
  }
  atomicRefUpdate(repoId, fn) {
    /* wrap fn in a transaction or lock */
  }
}
```

Key things to know:

- **Objects are immutable.** The same hash always maps to the same content, so `putObject` can safely ignore duplicates (SQL: `INSERT ... ON CONFLICT DO NOTHING`). No need for update logic.

- **`content` is the raw object body** (a `Uint8Array`), not the full git envelope. The adapter handles hashing and envelope framing. Store it as a blob/bytea column or binary value.

- **`putObjects` is the hot path.** It's called during push with every object in the pack. Wrapping it in a single transaction (rather than one insert per object) makes a large difference for SQL backends.

- **Refs are either direct or symbolic.** A `Ref` is `{ type: "direct", hash: string }` or `{ type: "symbolic", target: string }`. Store and return them as-is — the adapter resolves symref chains. `HEAD` is typically a symbolic ref pointing to `refs/heads/main`.

- **`atomicRefUpdate` provides isolation.** The adapter calls it to do compare-and-swap on refs (e.g. advancing a branch during a push). Wrap the callback in a SQL transaction, a mutex, or whatever your datastore supports. The callback receives `{ getRef, putRef, removeRef }` scoped to the transaction. For async backends, the callback returns a `Promise`.

- **All methods use `MaybeAsync<T>`.** Return `T` directly for sync backends (SQLite), or `Promise<T>` for async ones (Postgres, HTTP). The adapter handles both transparently.

- **`MemoryStorage` is the reference implementation** — it's under 150 lines and covers every method. Start there when building a new backend.

## Working with pushed code

Use the [repo module](REPO.md) (`just-git/repo`) inside hooks to inspect pushed commits, read files, diff trees, and more:

```ts
import { getChangedFiles, readFileAtCommit, getNewCommits } from "just-git/repo";

const server = createServer({
  storage: new BunSqliteStorage(db),
  hooks: {
    postReceive: async ({ repo, updates }) => {
      for (const update of updates) {
        const files = await getChangedFiles(repo, update.oldHash, update.newHash);
        const pkg = await readFileAtCommit(repo, update.newHash, "package.json");

        for await (const commit of getNewCommits(repo, update.oldHash, update.newHash)) {
          console.log(commit.message);
        }
      }
    },
  },
});
```

## Configuration

```ts
const server = createServer({
  // Storage backend (default: MemoryStorage)
  storage,
  policy,
  hooks,

  // Map request paths to repo IDs (default: identity)
  resolve: (path) => path,

  // Auto-create repos on first access
  autoCreate: true,

  // Strip a URL prefix (e.g. mount under /git/)
  basePath: "/git",

  // Pack cache for repeated full clones (default: enabled, 256 MB)
  packCache: { maxBytes: 512 * 1024 * 1024 }, // or false to disable

  // Delta compression tuning
  packOptions: {
    noDelta: false, // true = faster pack generation, larger packs
    deltaWindow: 10, // smaller = faster, worse compression
  },
});
```

## In-process client

Connect a [`createGit`](CLIENT.md) client directly to the server without starting an HTTP listener. The server's `asNetwork()` method returns a `NetworkPolicy` that routes all transport calls through the server's request handler in-process — no TCP, no serialization overhead, full hook/session/policy support.

```ts
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "just-git";
import { createServer } from "just-git/server";

const server = createServer({
  autoCreate: true,
  hooks: {
    preReceive: ({ session }) => {
      // hooks fire normally — session comes from the session builder
    },
  },
});

const git = createGit({
  network: server.asNetwork(), // default base URL: http://git
});

const bash = new Bash({ fs: new InMemoryFs(), cwd: "/", customCommands: [git] });
await bash.exec("git clone http://git/my-repo /work");
await bash.exec("git push origin main", { cwd: "/work" });
```

Pass a custom base URL when you need a specific hostname (e.g. to match a `resolve` callback or for config readability):

```ts
const git = createGit({
  network: server.asNetwork("http://my-server:8080"),
});
```

## Graceful shutdown

`close()` stops accepting new requests and waits for in-flight operations to finish. After calling, HTTP requests receive 503 and SSH sessions get exit 128.

```ts
// Stop the transport first (no new connections)
srv.stop();

// Then drain in-flight git operations
await server.close();

// Now safe to close the database
db.close();
```

Pass an `AbortSignal` for a timeout:

```ts
await server.close({ signal: AbortSignal.timeout(5000) });
```

`server.closed` is `true` after `close()` is called. Repo management methods (`createRepo`, `repo`, `deleteRepo`) remain available after close.

## Platform reference

[`src/platform/`](src/platform/) is a reference implementation that builds GitHub-like functionality on top of the server and repo modules: repository CRUD, pull requests, merge strategies (merge commit, squash, fast-forward), and push callbacks. It demonstrates what a full platform layer looks like using these primitives.

## Architecture

For protocol details, CAS semantics, interoperability notes, and design rationale, see [`src/server/DESIGN.md`](src/server/DESIGN.md).
