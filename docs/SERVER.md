# Server

Embeddable Git Smart HTTP server. Any standard git client (`git`, VS Code, GitHub Desktop) can clone from, fetch from, and push to repos served by just-git.

Uses web-standard `Request`/`Response` — works with Bun, Hono, Cloudflare Workers, Deno, or any fetch-compatible runtime. For Node.js's `http.createServer`, use `toNodeHandler`.

```ts
import { createGitServer } from "just-git/server";
```

## Quick start

```ts
import { createGitServer, BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const storage = new BunSqliteStorage(new Database("repos.sqlite"));

const server = createGitServer({
  resolveRepo: async (repoPath) => storage.repo(repoPath),
});

Bun.serve({ fetch: server.fetch });
```

For Node.js, wrap with `toNodeHandler`:

```ts
import http from "node:http";
import { createGitServer, BetterSqlite3Storage, toNodeHandler } from "just-git/server";
import Database from "better-sqlite3";

const storage = new BetterSqlite3Storage(new Database("repos.sqlite"));

const server = createGitServer({
  resolveRepo: async (repoPath) => storage.repo(repoPath),
});

http.createServer(toNodeHandler(server)).listen(3000);
```

That's enough for a working server. Clients can clone, fetch, and push:

```bash
git clone http://localhost:3000/my-repo
```

## `resolveRepo`

Maps an incoming URL path to a `GitRepo` (object store + ref store). This is the only required config.

```ts
resolveRepo: (repoPath: string, request: Request) => GitRepo | Response | null;
```

Return values:

- **`GitRepo`** — serve this repository
- **`null`** — respond with 404
- **`Response`** — send as-is (useful for 401/403 with custom headers)

The `repoPath` is the URL path with the git protocol suffix stripped. For `http://host/org/project/info/refs`, `repoPath` is `"org/project"`.

```ts
const server = createGitServer({
  resolveRepo: async (repoPath, request) => {
    const repo = await db.findRepo(repoPath);
    if (!repo) return null; // 404
    return storage.repo(repoPath);
  },
});
```

## Authorization

### `withAuth` — gate all access

Wraps `resolveRepo` with an auth check that fires on every request (clone, fetch, and push). Return `true` to allow, `false` for 403, or a `Response` for custom error responses.

```ts
import { createGitServer, withAuth } from "just-git/server";

const server = createGitServer({
  resolveRepo: withAuth(
    (request) => {
      const header = request.headers.get("Authorization");
      if (!header) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="git"' },
        });
      }
      return header === `Bearer ${process.env.GIT_TOKEN}`;
    },
    (repoPath) => storage.repo(repoPath),
  ),
});
```

### Public read, private write

Use `withAuth` for full lockdown, or `authorizePush` (in `createStandardHooks`) for the common pattern where anyone can clone but only authorized users can push:

```ts
const server = createGitServer({
  resolveRepo: (repoPath) => storage.repo(repoPath), // public reads
  hooks: createStandardHooks({
    authorizePush: (request) => request.headers.get("Authorization") === `Bearer ${token}`,
    protectedBranches: ["main"],
  }),
});
```

### Layered access control

Combine both for read/write permission tiers — `withAuth` checks read access, `authorizePush` checks write access:

```ts
const server = createGitServer({
  resolveRepo: withAuth(checkReadAccess, (repoPath) => storage.repo(repoPath)),
  hooks: createStandardHooks({
    authorizePush: checkWriteAccess,
    protectedBranches: ["main"],
  }),
});
```

## Hooks

Server hooks fire during push operations. All are optional.

```ts
const server = createGitServer({
  resolveRepo: async (repoPath) => storage.repo(repoPath),
  hooks: {
    preReceive: async ({ repo, updates, request }) => {
      // Reject pushes that delete the default branch
      for (const u of updates) {
        if (u.ref === "refs/heads/main" && u.isDelete) {
          return { reject: true, message: "cannot delete main" };
        }
      }
    },

    update: async ({ repo, update }) => {
      // Block force-pushes to protected branches
      if (update.ref === "refs/heads/main" && !update.isFF && !update.isCreate) {
        return { reject: true, message: "non-fast-forward to main" };
      }
    },

    postReceive: async ({ repo, repoPath, updates }) => {
      // Trigger CI, send notifications, inspect pushed code
      for (const u of updates) {
        const files = await getChangedFiles(repo, u.oldHash, u.newHash);
        console.log(`${repoPath}: ${u.ref} updated, ${files.length} files changed`);
      }
    },

    advertiseRefs: async ({ refs, service }) => {
      // Hide internal refs from clients
      return refs.filter((r) => !r.name.startsWith("refs/internal/"));
    },
  },
});
```

| Hook            | Fires when                                         | Can reject?                    |
| --------------- | -------------------------------------------------- | ------------------------------ |
| `preReceive`    | After objects are unpacked, before any ref updates | Yes — aborts entire push       |
| `update`        | Per-ref, after `preReceive` passes                 | Yes — blocks this ref only     |
| `postReceive`   | After all ref updates succeed                      | No                             |
| `advertiseRefs` | Client requests ref listing (clone/fetch/push)     | No — returns filtered ref list |

All hook payloads include `repo: GitRepo` and `request: Request`. Pre-hooks return `{ reject: true, message? }` to block the operation — the same `Rejection` protocol used by [client-side hooks](HOOKS.md).

### `createStandardHooks`

Covers common push policies without writing hooks manually:

```ts
import { createGitServer, createStandardHooks } from "just-git/server";

const server = createGitServer({
  resolveRepo: async (repoPath) => storage.repo(repoPath),
  hooks: createStandardHooks({
    protectedBranches: ["main", "production"],
    denyNonFastForward: true,
    denyDeletes: true,
    denyDeleteTags: true,
    authorizePush: (request) => request.headers.has("Authorization"),
    onPush: async ({ repoPath, updates }) => {
      console.log(`push to ${repoPath}: ${updates.length} refs`);
    },
  }),
});
```

`authorizePush` only gates push operations — clone and fetch are unaffected. For read access control, use [`withAuth`](#withauth--gate-all-access).

### Composing hooks

Combine multiple hook sets with `composeHooks()`. Pre-hooks chain in order and short-circuit on the first rejection. Post-hooks all run regardless.

```ts
import { createGitServer, composeHooks, createStandardHooks } from "just-git/server";

const server = createGitServer({
  resolveRepo: async (repoPath) => storage.repo(repoPath),
  hooks: composeHooks(
    createStandardHooks({ protectedBranches: ["main"] }),
    auditHooks,
    ciTriggerHooks,
  ),
});
```

## Storage backends

All three backends implement the `Storage` interface — `repo(repoId)` returns a `GitRepo`, `deleteRepo(repoId)` removes all data. Multiple repos share one store, partitioned by ID. They also work with `resolveRemote` for in-process cross-VFS transport alongside HTTP access.

> **Note:** All storage backends auto-create repos on first access via `.repo(id)`. If you pass `storage.repo(path)` directly as `resolveRepo`, any URL path will create a repo and accept pushes. For production, validate repo paths in `resolveRepo` or wrap with [`withAuth`](#withauth--gate-all-access) to gate access.

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
  resolveRepo: async (repoPath) => storage.repo(repoPath),
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
