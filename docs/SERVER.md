# Server

Embeddable Git server with Smart HTTP and SSH support. Any standard git client (`git`, VS Code, GitHub Desktop) can clone from, fetch from, and push to repos served by just-git.

HTTP uses web-standard `Request`/`Response` — works with Bun, Hono, Cloudflare Workers, Deno, or any fetch-compatible runtime. SSH uses web-standard `ReadableStream`/`WritableStream` — works with any SSH library through a thin adapter. For Node.js's `http.createServer`, use `server.nodeHandler`.

```ts
import { createGitServer } from "just-git/server";
```

## Quick start

```ts
import { createGitServer, BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const storage = new BunSqliteStorage(new Database("repos.sqlite"));

const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
});

Bun.serve({ fetch: server.fetch });
```

For Node.js, use `server.nodeHandler`:

```ts
import http from "node:http";
import { createGitServer, BetterSqlite3Storage } from "just-git/server";
import Database from "better-sqlite3";

const storage = new BetterSqlite3Storage(new Database("repos.sqlite"));

const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
});

http.createServer(server.nodeHandler).listen(3000);
```

That's enough for a working server. Clients can clone, fetch, and push:

```bash
git clone http://localhost:3000/my-repo
```

## `resolveRepo`

Maps a request path to a `GitRepo`. This is the only required config — the same function handles both HTTP and SSH.

```ts
resolveRepo: (repoPath: string) => GitRepo | null;
```

Return values:

- **`GitRepo`**: serve this repository
- **`null`**: 404 (HTTP) or exit 128 (SSH)

The `repoPath` is the URL path with the git protocol suffix stripped. For `http://host/org/project/info/refs`, `repoPath` is `"org/project"`. For SSH `git-upload-pack '/org/project'`, it's `"org/project"`.

```ts
const server = createGitServer({
  resolveRepo: async (repoPath) => {
    const exists = await db.repoExists(repoPath);
    if (!exists) return null;
    return storage.repo(repoPath);
  },
});
```

## Authorization

### Session builder

The optional `session` config builds a typed session object from each request. The session is available in all hooks. For HTTP, returning a `Response` rejects the request (e.g. 401). For SSH, auth is handled at the transport layer before the session builder runs.

```ts
const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
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
const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
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
const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
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
import { createGitServer, type SshChannel } from "just-git/server";

const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
});

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
const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
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
const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
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

    postReceive: async ({ repo, repoPath, updates }) => {
      for (const u of updates) {
        const files = await getChangedFiles(repo, u.oldHash, u.newHash);
        console.log(`${repoPath}: ${u.ref} updated, ${files.length} files changed`);
      }
    },

    advertiseRefs: async ({ refs, repoPath, session }) => {
      if (isPrivateRepo(repoPath) && !session?.token) {
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

All hook payloads include `repo: GitRepo` and `session`. Pre-hooks return `{ reject: true, message? }` to block the operation, using the same `Rejection` protocol as [client-side hooks](HOOKS.md).

### Composing hooks

Combine multiple hook sets with `composeHooks()`. Pre-hooks chain in order and short-circuit on the first rejection. Post-hooks all run regardless.

```ts
import { createGitServer, composeHooks } from "just-git/server";

const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
  hooks: composeHooks(auditHooks, ciTriggerHooks),
});
```

## Storage backends

All backends implement the `Storage` interface: `repo(repoId)` returns a `GitRepo`, `deleteRepo(repoId)` removes all data. Multiple repos share one store, partitioned by ID. They also work with `resolveRemote` for in-process cross-VFS transport alongside HTTP access.

> **Note:** All storage backends auto-create repos on first access via `.repo(id)`. If you pass `storage.repo(path)` directly as `resolveRepo`, any URL path will create a repo and accept pushes. For production, validate repo paths in `resolveRepo` or gate access with a [session builder](#session-builder), [policy](#policy), and [hooks](#hooks).

```ts
import type { Storage } from "just-git/server";
```

### `MemoryStorage`

```ts
import { MemoryStorage } from "just-git/server";
const storage = new MemoryStorage();
```

### `BunSqliteStorage`

For Bun. Takes a `bun:sqlite` `Database` directly.

```ts
import { BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";
const storage = new BunSqliteStorage(new Database("repos.sqlite"));
```

### `BetterSqlite3Storage`

For Node.js. Takes a `better-sqlite3` `Database` directly.

```ts
import { BetterSqlite3Storage } from "just-git/server";
import Database from "better-sqlite3";
const storage = new BetterSqlite3Storage(new Database("repos.sqlite"));
```

### `PgStorage`

Works with `pg` (node-postgres) or any driver matching the `PgDatabase` interface. Use `wrapPgPool` to adapt a `pg` Pool. `create()` is async (runs schema setup).

```ts
import { PgStorage, wrapPgPool } from "just-git/server";
import { Pool } from "pg";
const storage = await PgStorage.create(
  wrapPgPool(new Pool({ connectionString: process.env.DATABASE_URL })),
);
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
const storage = await PgStorage.create(db);
```

## Working with pushed code

Use the [repo module](REPO.md) (`just-git/repo`) inside hooks to inspect pushed commits, read files, diff trees, and more:

```ts
import { getChangedFiles, readFileAtCommit, getNewCommits } from "just-git/repo";

const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath),
  hooks: {
    postReceive: async ({ repo, updates }) => {
      for (const update of updates) {
        // List changed files
        const files = await getChangedFiles(repo, update.oldHash, update.newHash);

        // Read a specific file at the new commit
        const pkg = await readFileAtCommit(repo, update.newHash, "package.json");

        // Walk all new commits
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
const server = createGitServer({
  resolveRepo,
  policy,
  hooks,

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

## Platform reference

[`src/platform/`](src/platform/) is a reference implementation that builds GitHub-like functionality on top of the server and repo modules: repository CRUD, pull requests, merge strategies (merge commit, squash, fast-forward), and push callbacks. It demonstrates what a full platform layer looks like using these primitives.

## Architecture

For protocol details, CAS semantics, interoperability notes, and design rationale, see [`src/server/DESIGN.md`](src/server/DESIGN.md).
