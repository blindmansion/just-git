# Server

Embeddable Git server with Smart HTTP and SSH support. Any standard git client (`git`, VS Code, GitHub Desktop) can clone from, fetch from, and push to repos served by just-git.

HTTP uses web-standard `Request`/`Response` — works with Bun, Hono, Cloudflare Workers, Deno, or any fetch-compatible runtime. SSH uses web-standard `ReadableStream`/`WritableStream` — works with any SSH library through a thin adapter. For Node.js's `http.createServer`, use `server.nodeHandler`.

```ts
import { createServer } from "just-git/server";
```

## Quick start

```ts
import { createServer, BunSqliteDriver } from "just-git/server";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteDriver(new Database("repos.sqlite")),
});

await server.createRepo("my-repo");
Bun.serve({ fetch: server.fetch });
```

For Node.js, use `server.nodeHandler`:

```ts
import http from "node:http";
import { createServer, BetterSqlite3Driver } from "just-git/server";
import Database from "better-sqlite3";

const server = createServer({
  storage: new BetterSqlite3Driver(new Database("repos.sqlite")),
});

await server.createRepo("my-repo");
http.createServer(server.nodeHandler).listen(3000);
```

That's enough for a working server. Clients can clone, fetch, and push:

```bash
git clone http://localhost:3000/my-repo
```

## Repo management

The server manages repos through three methods:

| Method                     | Returns           | Description                                          |
| -------------------------- | ----------------- | ---------------------------------------------------- |
| `createRepo(id, options?)` | `GitRepo`         | Create a repo and initialize HEAD. Throws if exists. |
| `repo(id)`                 | `GitRepo \| null` | Get a repo, or `null` if it hasn't been created.     |
| `deleteRepo(id)`           | `void`            | Delete all data and the repo record.                 |

By default, requests to unknown repos return 404 (HTTP) or exit 128 (SSH). Set `autoCreate` to create repos on first access (e.g. for a push-to-create workflow):

```ts
const server = createServer({
  storage: new BunSqliteDriver(new Database("repos.sqlite")),
  autoCreate: true, // or { defaultBranch: "main" }
});
```

The optional `resolve` callback maps a request path to a repo ID. The default is identity — the URL path segment is the repo ID. For `http://host/org/project/info/refs`, the repo ID is `"org/project"`. For SSH `git-upload-pack '/org/project'`, it's `"org/project"`.

A request 404s if `resolve` returns `null` (bad path) or if the resolved ID doesn't match an existing repo (and `autoCreate` is off). Both cases produce the same response.

```ts
const server = createServer({
  storage: new BunSqliteDriver(db),
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
  storage: new BunSqliteDriver(db),
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
  storage: new BunSqliteDriver(db),
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
  storage: new BunSqliteDriver(db),
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
import { createServer, BunSqliteDriver, type SshChannel } from "just-git/server";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteDriver(new Database("repos.sqlite")),
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

## Policy

Declarative push rules that run before hooks. These are git-level constraints that don't depend on the session — for auth logic, use [hooks](#hooks).

```ts
const server = createServer({
  storage: new BunSqliteDriver(db),
  policy: {
    protectedBranches: ["main", "production"],
    denyNonFastForward: true,
    denyDeletes: true,
    denyDeleteTags: true,
  },
});
```

| Option               | Effect                                               |
| -------------------- | ---------------------------------------------------- |
| `protectedBranches`  | Listed branches cannot be force-pushed to or deleted |
| `denyNonFastForward` | Reject all non-fast-forward pushes globally          |
| `denyDeletes`        | Reject all ref deletions globally                    |
| `denyDeleteTags`     | Tags are immutable — no deletion, no overwrite       |

Policy rules are checked first. If a policy check rejects, user hooks don't run.

## Hooks

Server hooks fire during push and ref advertisement. All are optional.

```ts
const server = createServer({
  storage: new BunSqliteDriver(db),
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
  storage: new BunSqliteDriver(db),
  hooks: composeHooks(auditHooks, ciTriggerHooks),
});
```

## Storage drivers

Pass a `StorageDriver` to the server via `storage`. Multiple repos are partitioned by ID in a single store. Drivers also work with `resolveRemote` for in-process cross-VFS transport alongside HTTP access (use `server.repo(id)` to get the `GitRepo`).

### `MemoryDriver`

```ts
import { createServer, MemoryDriver } from "just-git/server";

const server = createServer({ storage: new MemoryDriver() });
await server.createRepo("my-repo");
```

### `BunSqliteDriver`

For Bun. Takes a `bun:sqlite` `Database` directly.

```ts
import { createServer, BunSqliteDriver } from "just-git/server";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteDriver(new Database("repos.sqlite")),
});
await server.createRepo("my-repo");
```

### `BetterSqlite3Driver`

For Node.js. Takes a `better-sqlite3` `Database` directly.

```ts
import { createServer, BetterSqlite3Driver } from "just-git/server";
import Database from "better-sqlite3";

const server = createServer({
  storage: new BetterSqlite3Driver(new Database("repos.sqlite")),
});
await server.createRepo("my-repo");
```

### `PgDriver`

Works with `pg` (node-postgres) or any driver matching the `PgDatabase` interface. Use `wrapPgPool` to adapt a `pg` Pool. `PgDriver.create()` is async (runs schema setup).

```ts
import { createServer, PgDriver, wrapPgPool } from "just-git/server";
import { Pool } from "pg";

const server = createServer({
  storage: await PgDriver.create(
    wrapPgPool(new Pool({ connectionString: process.env.DATABASE_URL })),
  ),
});
await server.createRepo("my-repo");
```

For other drivers, construct a `PgDatabase` directly:

```ts
const db: PgDatabase = {
  query: (text, values) => myDriver.query(text, values),
  transaction: async (fn) => {
    await myDriver.query("BEGIN");
    try {
      const result = await fn(db);
      await myDriver.query("COMMIT");
      return result;
    } catch (err) {
      await myDriver.query("ROLLBACK");
      throw err;
    }
  },
};
const server = createServer({
  storage: await PgDriver.create(db),
});
await server.createRepo("my-repo");
```

## Working with pushed code

Use the [repo module](REPO.md) (`just-git/repo`) inside hooks to inspect pushed commits, read files, diff trees, and more:

```ts
import { getChangedFiles, readFileAtCommit, getNewCommits } from "just-git/repo";

const server = createServer({
  storage: new BunSqliteDriver(db),
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
