# Server Module Design

## Why this exists

just-git is a pure TypeScript git implementation for virtual filesystems. The server module adds the ability to **serve** git repos over Smart HTTP — the same protocol real git servers speak. Any standard git client can clone from, fetch from, and push to a just-git server.

### Relationship to base just-git

The server is a sub-export of just-git (`just-git/server`), not a separate package. This is intentional:

- The server code reaches into 8+ internal `lib/` modules (pkt-line, packfile, object-walk, merge, sha1, tag parsing, hex constants, core types). Extracting it would require either exporting all of those as public API or duplicating them.
- The server is the mirror of `SmartHttpTransport` — the client side of the Smart HTTP protocol already lives in just-git. They share pkt-line framing, pack format, capability negotiation.
- The `ObjectStore` and `RefStore` interfaces are the shared abstraction. Both the VFS-backed git commands and the server operate through them. `BunSqliteStorage`/`BetterSqlite3Storage`/`MemoryStorage` are just other backing stores — they're extensions of the library, not a separate library.
- The sub-export (`"./server"` in package.json) means users who only need the VFS git commands never load server code. Tree-shaking works.

### Relationship to `resolveRemote`

`resolveRemote` handles in-process git transport. An agent's `git clone/fetch/push` resolves the remote URL via a callback that returns a `GitRepo` — which can be another agent's VFS-backed repo, a `server.repo()`, or any `ObjectStore + RefStore` pair. Zero HTTP overhead, full CAS-protected push semantics.

The server module adds two things `resolveRemote` can't do:

1. **Real git client access.** A human (or external tool) can `git clone http://your-server/repo`. VS Code, GitHub Desktop, the `git` CLI — anything that speaks git — can interact with server-hosted repos. `resolveRemote` is a closed system; only just-git clients can participate.

2. **Crossing process/network boundaries.** `resolveRemote` requires `GitRepo` instances in the same process (passing object references). The server works over HTTP across machines or deployments.

They're complementary. Both can target the same backing stores (e.g. the same SQLite database via `BunSqliteStorage`). An agent can `resolveRemote` push to a `server.repo()` that the server also serves over HTTP. CAS at the `RefStore` level ensures correctness regardless of which path performs the write.

## Target use case

The primary audience is **per-user-code applications** — apps where AI agents write code bespoke for individual users.

One approach to these apps is microvms (real OS, real filesystem, real git). just-git pursues a different path: everything in code, no real filesystems, which enables running in CF Workers, browsers, Durable Objects, or any lightweight runtime.

In this model:

- **just-git** (base) gives agents a working git in a VFS
- **The server module** provides persistence (SQLite/edge storage instead of VFS blobs), external access (users can `git clone` their code), and a programmable coordination layer (hooks that can inspect and act on pushed code)

### What makes this novel

There is no existing solution that provides an embeddable, programmable git server as a TypeScript library. The landscape:

- **Gitea/Forgejo/Gogs** — Go binaries. Customization means forking Go code or external webhooks. Can't inspect pushes in-process.
- **GitLab** — Massive Ruby/Go stack. Not embeddable.
- **Soft Serve** — Charm's SSH git server in Go. Not embeddable or programmable.
- **git-http-backend** — CGI wrapper around real git. Requires git binary, can't introspect pushes without shelling out.

The just-git server lets push handlers read commits, diff trees, inspect files, and make decisions — all in-process, all TypeScript, no git binary.

### Interop

The Smart HTTP protocol surface is small and well-specified. Protocol v1 uses three endpoints (`info/refs`, `git-upload-pack`, `git-receive-pack`). Protocol v2 is also supported for upload-pack (`ls-refs` + `fetch` commands) over both HTTP and SSH; receive-pack uses v1.

Features not implemented that generally don't matter for the target use case:

| Feature                     | Matters for agents? |
| --------------------------- | ------------------- |
| Partial clones (`--filter`) | No                  |
| LFS                         | Unlikely for now    |

Shallow clones (`--depth`) and SSH transport are both implemented. Shallow clone support includes `computeShallowBoundary`, depth/shallow/unshallow negotiation, and the `shallow` capability in upload-pack. SSH transport is handled via `server.handleSession`.

## Architecture

### Design principles

The server has a minimal set of extension points:

1. **`storage`** — persistence: where are objects and refs stored?
2. **`resolve`** — routing: which repo ID does this request path map to?
3. **`hooks`** — reactions: what happens during the exchange?

Everything else (protocol mechanics, pack encoding, ref advertisement format) is deterministic and not configurable. This keeps the API surface small and focused.

### Layers

**Layer 1: Protocol primitives** (`protocol.ts`)

Pure functions for building and parsing Git Smart HTTP wire format. No I/O, no state.

- `buildRefAdvertisement` — ref advertisement response body
- `parseUploadPackRequest` / `buildUploadPackResponse` — fetch/clone protocol
- `parseReceivePackRequest` / `buildReportStatus` — push protocol
- `encodeSidebandPacket` — sideband-64k framing

**Layer 1: Operations** (`operations.ts`)

Higher-level functions that combine protocol primitives with storage access.

- `collectRefs` — reads refs from a repo, returns structured `RefAdvertisement[]` data (no wire encoding)
- `buildRefAdvertisementBytes` — encodes a ref list into wire format
- `handleUploadPack` — parses wants/haves, enumerates objects, builds packfile
- `ingestReceivePack` — parses push commands, ingests pack, computes enriched `RefUpdate[]` with `isFF`/`isCreate`/`isDelete`. Does **not** apply ref updates — the handler does that after running hooks.

These accept `GitRepo` and return structured data or response bodies. No HTTP, no framework coupling.

**Layer 2: HTTP handler** (`handler.ts`)

Thin adapter mapping web-standard `Request`/`Response` to the operations layer. Framework-agnostic — works with Bun.serve, Hono, Cloudflare Workers, or anything that speaks fetch API.

The handler owns the hook invocation lifecycle:

```
info/refs:      collectRefs → advertiseRefs hook (filter) → buildRefAdvertisementBytes → Response
upload-pack:    handleUploadPack → Response
receive-pack:   ingestReceivePack → preReceive hook → per-ref update hook → apply refs → postReceive hook → Response
```

**Node.js adapter** (`handler.ts` — `toNodeHandler`)

Converts between Node's `IncomingMessage`/`ServerResponse` and the web-standard `Request`/`Response` used by the handler. This is a convenience wrapper — it buffers the full response body (via `response.arrayBuffer()`) before writing to the Node response. For web-standard runtimes (Bun, Deno, Workers), the `fetch` handler can return streaming `ReadableStream` responses directly. For Node deployments serving large repos where streaming matters, implement a custom adapter that pipes `response.body` to the Node response.

**Repo helpers** (`just-git/repo`)

Standalone functions for working with `GitRepo` directly, exported from `just-git/repo` (not the server module). Thin wrappers over lib/ primitives useful inside hooks and outside the server:

- `getNewCommits` — walk commits introduced by a ref update
- `getChangedFiles` — diff trees between two commits
- `isAncestor`, `resolveRef`, `listBranches`, `listTags`
- `readCommit`, `readBlob`, `readBlobText`, `flattenTree`, `diffTrees`

**Policy** (`handler.ts` — `buildPolicyHooks`)

Declarative push rules on `GitServerConfig.policy`: branch protection, force-push denial, delete denial, tag immutability. Non-generic, auth-independent. Internally generates hooks that run before user-provided hooks.

**Storage** (`storage.ts`, `bun-sqlite-storage.ts`, `better-sqlite3-storage.ts`, `memory-storage.ts`, `pg-storage.ts`)

Two-layer architecture: `Storage` implementations (`BunSqliteStorage`, `BetterSqlite3Storage`, `PgStorage`, `MemoryStorage`) provide raw key-value CRUD. `createStorageAdapter(driver)` is called internally by `createServer` to wrap any driver with shared git-aware logic (object hashing, pack ingestion, symref resolution, CAS). Multiple repos partitioned by ID in a single store.

Repos require explicit creation via `server.createRepo(id)`, or set `autoCreate: true` in the server config for automatic creation on first access. `server.repo(id)` returns `null` for unregistered repos — unknown paths get 404 responses.

### Type hierarchy

```
GitRepo { objectStore: ObjectStore, refStore: RefStore, hooks?: HookEmitter }
    └── base type — used by operations.ts, helpers.ts, and ~35 lib functions directly
    └── server.repo() returns GitRepo (or null for 404)

GitContext extends GitRepo { fs, gitDir, workTree, credentialProvider?, ... }
    └── used by command handlers and lib functions that need filesystem access
```

`GitRepo` is the minimal repository handle: sufficient for all pure object/ref operations (read, write, walk, diff trees, merge-base, blame, etc.) without filesystem access. The server module operates entirely through `GitRepo`. The base library's `GitContext` extends it, adding filesystem, paths, and operator-level extensions.

This split is enforced at the type level — lib functions that don't need filesystem access accept `GitRepo`, so calling them from the server is statically safe. No runtime stubs or proxies needed.

## API

### `createServer`

```typescript
import { createServer, BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteStorage(new Database("repos.sqlite")),
  autoCreate: true,
  hooks: {
    /* optional ServerHooks */
  },
  basePath: "/git", // optional URL prefix to strip
  onError: (err, auth) => {
    // Custom error logging. Default logs just the message (no stack trace).
    // Set to `false` to suppress all output.
    myLogger.error("git server error", { err });
  },
});

// Standard fetch-API handler
Bun.serve({ fetch: server.fetch });
```

**`onError`** controls what happens when the server catches an unhandled error (e.g. a storage backend throwing). The default handler logs only `err.message` to `console.error` — no stack traces, no internal paths. Pass a function to integrate with your logging system, or `false` to suppress all output. The HTTP response is always a generic 500 regardless.

### ServerHooks

Four hook points covering the full push/fetch lifecycle:

```typescript
interface ServerHooks {
  // Batch-level push gate. Reject to abort the entire push.
  preReceive?: (event: PreReceiveEvent) => void | Rejection | Promise<void | Rejection>;

  // Per-ref push gate. Reject to block one ref while allowing others.
  update?: (event: UpdateEvent) => void | Rejection | Promise<void | Rejection>;

  // Post-push notification. Cannot reject.
  postReceive?: (event: PostReceiveEvent) => void | Promise<void>;

  // Filter refs advertised to clients during fetch or push.
  advertiseRefs?: (event: AdvertiseRefsEvent) => RefAdvertisement[] | void | Promise<...>;
}
```

**Design decisions:**

- **No auth system.** `request` is passed through on every hook event so authors can read headers, but the server has no concept of users, tokens, or permissions. Auth is checked in `preReceive` or `advertiseRefs` against whatever user store the platform uses.
- **No built-in fast-forward enforcement.** The `isFF` boolean is computed and available on `RefUpdate`, but the server doesn't reject non-FF pushes by default. That's a policy decision — use `policy: { denyNonFastForward: true }` for the common case.
- **No webhooks/notification system.** `postReceive` is the trigger point; delivery mechanics (HTTP calls, queues, retries) are user-land.
- **No repo lifecycle management.** `Storage` provides `createRepo`/`deleteRepo` for basic CRUD, but higher-level concerns (forking, naming conventions, org hierarchy, listing/querying repos) are platform concerns.
- **Events are pure data.** No methods on event payloads — use standalone helpers instead. This keeps events serializable and testable.

### Hook event payloads

```typescript
interface RefUpdate {
  ref: string; // "refs/heads/main"
  oldHash: string | null; // null = new ref
  newHash: string; // ZERO_HASH = delete
  isFF: boolean; // fast-forward?
  isCreate: boolean;
  isDelete: boolean;
}

interface PreReceiveEvent {
  repo: GitRepo;
  repoId: string; // resolved repo ID (e.g. "my-org/my-repo")
  updates: readonly RefUpdate[];
  request: Request;
}

interface UpdateEvent {
  repo: GitRepo;
  repoId: string;
  update: RefUpdate;
  request: Request;
}

interface PostReceiveEvent {
  repo: GitRepo;
  repoId: string;
  updates: readonly RefUpdate[]; // only successfully applied updates
  request: Request;
}

interface AdvertiseRefsEvent {
  repo: GitRepo;
  repoId: string;
  refs: RefAdvertisement[];
  service: "git-upload-pack" | "git-receive-pack";
  request: Request;
}

interface Rejection {
  reject: true;
  message?: string;
}
```

### Standalone helpers

```typescript
import { getNewCommits, getChangedFiles, readCommit } from "just-git/repo";

// Inside a postReceive hook:
postReceive: async (event) => {
  for (const update of event.updates) {
    if (update.ref === "refs/heads/main" && !update.isDelete) {
      const files = await getChangedFiles(event.repo, update.oldHash, update.newHash);
      if (files.some((f) => f.path.startsWith("src/"))) {
        await triggerBuild(event.repo);
      }
    }
  }
};

// Outside any server context:
const commit = await readCommit(repo, hash);
const branches = await listBranches(repo);
```

### Policy + hooks

```typescript
import { createServer, BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteStorage(new Database("repos.sqlite")),
  autoCreate: true,
  policy: {
    protectedBranches: ["main", "production"],
    denyNonFastForward: true,
    denyDeletes: true,
  },
  hooks: {
    preReceive: ({ auth }) => {
      if (!auth.request?.headers.has("Authorization"))
        return { reject: true, message: "unauthorized" };
    },
    postReceive: async ({ updates }) => {
      console.log(`Push to ${updates.map((u) => u.ref).join(", ")}`);
    },
  },
});
```

## Receive-pack flow

The push handling flow with hooks:

```
1. Parse request body → PushCommand[] + packfile bytes
2. Ingest packfile into ObjectStore
3. Compute RefUpdate[] with isFF/isCreate/isDelete (ancestry walk)
4. preReceive hook → reject entire push if Rejection returned
5. For each ref:
   a. update hook → skip this ref if Rejection returned
   b. CAS: compareAndSwapRef(ref, clientOldHash, newRef)
   c. If CAS fails → report "failed to lock" for that ref
6. postReceive hook (fire-and-forget, only successful updates)
7. Build report-status response
```

Objects are ingested before hooks fire (step 2) so hooks can inspect pushed content. For deferrable server-backed stores, newly inserted objects are rolled back if `preReceive` rejects or if later validation / `update` hooks / CAS checks leave the push with zero applied refs. Partial-success pushes still keep their ingested objects, matching the need to preserve objects referenced by successful ref updates.

## Working copies in hooks

Beyond read-only inspection via helpers, some hook use cases require a full working tree — running tests against pushed code, having an agent inspect or modify files, running git CLI operations.

### Three tiers of hook capability

| Tier               | API                                   | VFS needed | Concurrent-safe | Use cases                                |
| ------------------ | ------------------------------------- | ---------- | --------------- | ---------------------------------------- |
| **Inspection**     | Standalone helpers                    | No         | Yes             | Read commits, diff trees, check ancestry |
| **Read-only tree** | `extractTree()` or `createWorktree()` | Yes        | Yes             | Lint, test, inspect files at a commit    |
| **Write-capable**  | `resolveRemote` + clone + push        | Yes        | Yes (CAS)       | Agent edits files, commits, pushes back  |

Most hooks only need the inspection tier. The read-only tree tier populates a VFS from a commit for file-level access. The write-capable tier gives an agent a full isolated git environment with CAS-protected pushes.

### Inspection (no VFS)

Standalone helpers operate directly on the `GitRepo` — no filesystem needed.

```typescript
preReceive: async ({ repo, updates }) => {
  for (const update of updates) {
    const files = await getChangedFiles(repo, update.oldHash, update.newHash);
    const commit = await readCommit(repo, update.newHash);
    const content = await readFileAtCommit(repo, update.newHash, "package.json");
    // enforce policies, validate, etc.
  }
};
```

### Read-only tree (lightweight VFS)

`extractTree()` writes worktree files to a VFS without any `.git` structure — just the files. `createWorktree()` additionally builds a git index and `.git` scaffold, enabling git commands like `status`, `log`, `diff`, and `show`.

Wrap the repo with `readonlyRepo()` to enforce read-only access — any write operation (`git add`, `git commit`, `git checkout -b`, etc.) will fail with a clear error instead of silently modifying the shared store.

```typescript
// extractTree — just the files
const fs = new InMemoryFs();
await extractTree(repo, "refs/heads/main", fs, "/workspace");
const pkg = await fs.readFile("/workspace/package.json");

// createWorktree — files + index + .git scaffold, enforced read-only
const ro = readonlyRepo(repo);
const fs = new InMemoryFs();
const { ctx } = await createWorktree(ro, fs, { workTree: "/repo" });
const git = createGit({
  objectStore: ro.objectStore,
  refStore: ro.refStore,
});
const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
await bash.exec("git log --oneline"); // works
await bash.exec("git diff HEAD~1"); // works
await bash.exec("git add ."); // fails: "read-only"
```

When `GitOptions.objectStore` / `GitOptions.refStore` are provided, they override the filesystem-backed stores that `findRepo` constructs, so git commands read objects and refs from the shared backend.

### Write-capable agent (resolveRemote + clone)

For agents that need to commit and have those commits safely land in the shared store, the recommended approach is `resolveRemote` — the agent clones into an isolated VFS repo and pushes back. The push goes through `LocalTransport`, which uses `compareAndSwapRef` for concurrent safety.

```typescript
postReceive: async ({ repo, repoId }) => {
  const git = createGit({
    resolveRemote: () => repo,
    identity: { name: "Agent", email: "agent@ci.dev" },
  });
  const fs = new InMemoryFs();
  const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

  await bash.exec(`git clone local://${repoId} /repo`);
  await bash.exec("git checkout -b fix/auto-format");
  // ... edit files, git add, git commit ...
  await bash.exec("git push origin fix/auto-format");
};
```

The `resolveRemote` callback returns the `GitRepo` for any non-HTTP remote URL. The URL scheme is arbitrary — `local://`, `repo://`, or any non-HTTP string — it's just a key the callback receives. The clone copies objects into the VFS (temporary in-memory duplication), and the push transfers them back with CAS protection.

**Why not write directly?** `createWorktree` with store overrides lets an agent commit directly to the shared store without cloning or pushing. This is simpler but bypasses CAS — `git commit` uses unconditional `writeRef`, so a concurrent HTTP push could race with the agent's ref update. The resolveRemote + clone approach avoids this entirely: the agent works in isolation and the push is the single serialization point, protected by `compareAndSwapRef`.

Direct store access via `createWorktree` is safe for single-writer scenarios (pre-receive hooks where the push blocks until the hook returns, or background tasks with no concurrent pushes to the same branch).

## Concurrent push safety

Ref updates during push use compare-and-swap (CAS) to prevent lost updates when multiple writers target the same ref concurrently.

### `RefStore.compareAndSwapRef`

```typescript
compareAndSwapRef(
  name: string,
  expectedOldHash: string | null,  // null = create-only (ref must not exist)
  newRef: Ref | null               // null = conditional delete
): Promise<boolean>;               // true = succeeded, false = ref moved
```

Required on all `RefStore` implementations. Returns `false` when the ref's current resolved hash doesn't match `expectedOldHash`, meaning another writer updated the ref between the caller's read and write.

### Implementations

- **SQLite drivers** — the `atomicRefUpdate` callback runs inside `db.transaction()`. SQLite's write lock serializes concurrent transactions, making CAS truly atomic across all callers sharing the same database.

- **`FileSystemRefStore`** — read-compare-write. Safe for VFS use because the in-memory filesystem has no real I/O concurrency between `await` points.

### Where CAS is used

| Writer                      | CAS expected value                 | Protects against                |
| --------------------------- | ---------------------------------- | ------------------------------- |
| Server receive-pack handler | `oldHash` from client push command | Concurrent HTTP pushes          |
| `LocalTransport.push`       | `oldHash` from `advertiseRefs`     | Concurrent resolveRemote pushes |
| `Platform.mergePullRequest` | `baseSha` read before merge        | Push racing with PR merge       |

All three paths can target the same backing store (e.g. the same SQLite database). CAS at the `RefStore` level ensures correctness regardless of which code path performs the write.

### Behavior on CAS failure

- **Server handler**: reports `ng <ref> failed to lock` in the report-status response. The client sees a rejected push and can retry.
- **LocalTransport**: reports `failed to lock ref '<ref>'`. The push command surfaces this as a rejected update.
- **Platform merge**: throws `MergeError` with message "base branch was updated concurrently". The caller can retry the merge.

## Garbage collection

`server.gc(repoId, options?)` removes unreachable objects from a repo's storage. Unlike the VFS-based `gc`/`repack` commands (which deal with loose objects, pack files, and filesystem layout), server-side GC operates on database rows: walk refs → enumerate reachable hashes → delete the rest.

### Implementation

The core logic lives in `gc.ts`. The flow:

1. **Snapshot refs** — `refStore.listRefs()` captures the current ref state.
2. **Walk reachability** — `enumerateObjects(repo, tips, [])` from `object-walk.ts` collects all hashes reachable from ref tips. This uses `GitRepo` (objectStore + refStore) and requires no filesystem access.
3. **List stored hashes** — `driver.listObjectHashes(repoId)` returns all object hashes in the repo's partition.
4. **Compute unreachable** — set difference: stored − reachable.
5. **Safety check** — re-read refs; if any changed since step 1, abort with `{ aborted: true }`.
6. **Delete** — `driver.deleteObjects(repoId, unreachableHashes)`.

### Concurrency safety

The ref-change check (step 5) prevents the most common race: a push completing during the GC walk. If refs changed, the reachable set may be stale, so GC aborts rather than risk deleting newly-reachable objects. The caller can retry.

Objects added by an in-flight push that hasn't committed its refs yet are safe — they weren't in the step-3 hash listing (which happened before the push's object ingestion), so they're not in the deletion set.

GC should not run concurrently with pushes to the same repo. The abort-on-change check catches completed pushes, but objects mid-ingestion (before ref update) create a window where the invariant is harder to enforce without locking. For production use, pause pushes to the repo before running GC, or schedule GC during low-activity windows.

### Storage interface

Two methods on `Storage` support GC:

- `listObjectHashes(repoId)` — returns all stored hashes for a repo.
- `deleteObjects(repoId, hashes)` — deletes specific objects by hash, returns count deleted.

These are raw primitives on the driver interface. The GC logic (reachability walk, set diff, safety check) stays in the adapter/server layer where git-awareness lives — drivers remain git-unaware.

### Relationship to VFS GC

The VFS-based `gc` command handles a fundamentally different storage model: loose objects under `.git/objects/`, pack files, `.idx` files, reflog expiry, and pack consolidation. The only shared code is `object-walk.ts` for the reachability walk — everything else is different. Server GC doesn't reuse `repackFromTips`, `collectAllRoots`, `pruneAllLoose`, or any of the filesystem-oriented GC machinery.

## Future work

- **`atomic` push capability** — the Git Smart HTTP protocol defines `atomic` as a server-advertised capability. When a client sends `--atomic`, the server guarantees all-or-nothing ref updates: if any ref CAS fails or a hook rejects one ref, all are rolled back. Currently the server applies refs individually in a loop — each ref gets its own CAS, so a multi-ref push can partially succeed. The client-side transports (`LocalTransport`, `SmartHttpTransport`) already enforce atomic semantics before sending, so this only matters for external git clients pushing multiple refs with `--atomic`. Implementation: add `"atomic"` to `RECEIVE_PACK_CAPS`, detect the capability in the client's request, and batch all `compareAndSwapRef` calls into a single `db.transaction()`. Low priority — agent repos almost always push a single ref at a time.

- **Sideband progress messages** — the server can write to sideband-64k band-2 (stderr) during `receive-pack` to send progress messages or warnings back to the pushing client. This would let long-running hooks give feedback (e.g. "running tests...", "checking policy...") instead of the client seeing silence until the push completes.

- **Additional presets** — commit message validation, file size limits, path restrictions, audit logging.
