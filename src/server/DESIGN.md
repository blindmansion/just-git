# Server Module Design

## Why this exists

just-git is a pure TypeScript git implementation for virtual filesystems. The server module adds the ability to **serve** git repos over Smart HTTP — the same protocol real git servers speak. Any standard git client can clone from, fetch from, and push to a just-git server.

### Relationship to base just-git

The server is a sub-export of just-git (`just-git/server`), not a separate package. This is intentional:

- The server code reaches into 8+ internal `lib/` modules (pkt-line, packfile, object-walk, merge, sha1, tag parsing, hex constants, core types). Extracting it would require either exporting all of those as public API or duplicating them.
- The server is the mirror of `SmartHttpTransport` — the client side of the Smart HTTP protocol already lives in just-git. They share pkt-line framing, pack format, capability negotiation.
- The `ObjectStore` and `RefStore` interfaces are the shared abstraction. Both the VFS-backed git commands and the server operate through them. `SqliteStorage` is just another backing store — it's an extension of the library, not a separate library.
- The sub-export (`"./server"` in package.json) means users who only need the VFS git commands never load server code. Tree-shaking works.

### Relationship to `resolveRemote`

`resolveRemote` handles in-process git transport. An agent's `git clone/fetch/push` resolves the remote URL via a callback that returns a `GitRepo` — which can be another agent's VFS-backed repo, a `SqliteStorage.repo()`, or any `ObjectStore + RefStore` pair. Zero HTTP overhead, full CAS-protected push semantics.

The server module adds two things `resolveRemote` can't do:

1. **Real git client access.** A human (or external tool) can `git clone http://your-server/repo`. VS Code, GitHub Desktop, the `git` CLI — anything that speaks git — can interact with server-hosted repos. `resolveRemote` is a closed system; only just-git clients can participate.

2. **Crossing process/network boundaries.** `resolveRemote` requires `GitRepo` instances in the same process (passing object references). The server works over HTTP across machines or deployments.

They're complementary. Both can target the same backing stores (e.g. the same SQLite database via `SqliteStorage`). An agent can `resolveRemote` push to a `SqliteStorage.repo()` that the server also serves over HTTP. CAS at the `RefStore` level ensures correctness regardless of which path performs the write.

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

The Smart HTTP protocol surface is small and well-specified. The three endpoints (`info/refs`, `git-upload-pack`, `git-receive-pack`) with protocol v1 are sufficient for any standard git client to clone, fetch, and push.

Features not yet implemented that generally don't matter for the target use case:

| Feature                                     | Matters for agents?                                   |
| ------------------------------------------- | ----------------------------------------------------- |
| Protocol v2                                 | No — v1 works, clients fall back                      |
| Shallow clones (`--depth`)                  | Rarely — agent repos are small                        |
| Partial clones (`--filter`)                 | No                                                    |
| SSH transport                               | No — bearer token auth over HTTP is better for agents |
| LFS                                         | Unlikely for now                                      |
| Delta compression in server-generated packs | Performance optimization, not correctness             |

Concurrent push safety (ref CAS) is the one gap that matters for production use.

## Architecture

### Design principles

The server has exactly two extension points:

1. **`resolveRepo`** — routing: which repo does this request target?
2. **`hooks`** — reactions: what happens during the exchange?

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

**Helpers** (`helpers.ts`)

Standalone functions for working with `GitRepo` directly. Thin wrappers over lib/ primitives that are useful inside hooks and outside the server entirely:

- `getNewCommits` — walk commits introduced by a ref update
- `getChangedFiles` — diff trees between two commits
- `isAncestor`, `resolveRef`, `listBranches`, `listTags`
- `readCommit`, `readBlob`, `readBlobText`, `flattenTree`, `diffTrees`

**Presets** (`presets.ts`)

Opinionated hook configurations for common setups:

- `createStandardHooks` — branch protection, force-push denial, delete denial, auth, post-push callback

**Storage** (`sqlite-storage.ts`)

`SqliteStorage` — multi-repo SQLite backend implementing `ObjectStore` and `RefStore`. Multiple repos partitioned by `repo_id` in a single database.

### Type hierarchy

```
GitRepo { objectStore: ObjectStore, refStore: RefStore, hooks?: HookEmitter }
    └── base type — used by operations.ts, helpers.ts, and ~35 lib functions directly
    └── server's resolveRepo() callback returns GitRepo (or null for 404)

GitContext extends GitRepo { fs, gitDir, workTree, credentialProvider?, ... }
    └── used by command handlers and lib functions that need filesystem access
```

`GitRepo` is the minimal repository handle: sufficient for all pure object/ref operations (read, write, walk, diff trees, merge-base, blame, etc.) without filesystem access. The server module operates entirely through `GitRepo`. The base library's `GitContext` extends it, adding filesystem, paths, and operator-level extensions.

This split is enforced at the type level — lib functions that don't need filesystem access accept `GitRepo`, so calling them from the server is statically safe. No runtime stubs or proxies needed.

## API

### `createGitServer`

```typescript
import { createGitServer } from "just-git/server";

const server = createGitServer({
  resolveRepo: async (repoPath, request) => {
    // Return a GitRepo, or null to 404
    return storage.repo(repoPath);
  },
  hooks: {
    /* optional ServerHooks */
  },
  basePath: "/git", // optional URL prefix to strip
});

// Standard fetch-API handler
Bun.serve({ fetch: server.fetch });
```

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
- **No built-in fast-forward enforcement.** The `isFF` boolean is computed and available on `RefUpdate`, but the server doesn't reject non-FF pushes by default. That's a policy decision for hooks. Use `createStandardHooks({ denyNonFastForward: true })` for the common case.
- **No webhooks/notification system.** `postReceive` is the trigger point; delivery mechanics (HTTP calls, queues, retries) are user-land.
- **No repo creation/management.** `resolveRepo` returns existing repos. How repos get created, named, or forked is a platform concern.
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
  repoPath: string; // path from resolveRepo (e.g. "my-org/my-repo")
  updates: readonly RefUpdate[];
  request: Request;
}

interface UpdateEvent {
  repo: GitRepo;
  repoPath: string;
  update: RefUpdate;
  request: Request;
}

interface PostReceiveEvent {
  repo: GitRepo;
  repoPath: string;
  updates: readonly RefUpdate[]; // only successfully applied updates
  request: Request;
}

interface AdvertiseRefsEvent {
  repo: GitRepo;
  repoPath: string;
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
import { getNewCommits, getChangedFiles, readCommit } from "just-git/server";

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

### Presets

```typescript
import { createStandardHooks } from "just-git/server";

const server = createGitServer({
  resolveRepo: (path) => storage.repo(path),
  hooks: createStandardHooks({
    protectedBranches: ["main", "production"],
    denyNonFastForward: true,
    denyDeletes: true,
    authorize: (req) => req.headers.get("Authorization") === "Bearer secret",
    onPush: async (event) => {
      console.log(`Push to ${event.updates.map((u) => u.ref).join(", ")}`);
    },
  }),
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

Objects are ingested before hooks fire (step 2) so hooks can inspect pushed content. If `preReceive` rejects, those objects become orphaned — same behavior as real git. A future `gc()` on the storage backend can clean them up.

## Working copies in hooks

Beyond read-only inspection via helpers, some hook use cases require a full working tree — running tests against pushed code, having an agent inspect or modify files, running git CLI operations.

### Three tiers of hook capability

| Tier               | API                                  | VFS needed | Concurrent-safe | Use cases                                |
| ------------------ | ------------------------------------ | ---------- | --------------- | ---------------------------------------- |
| **Inspection**     | Standalone helpers                   | No         | Yes             | Read commits, diff trees, check ancestry |
| **Read-only tree** | `checkoutTo()` or `createWorktree()` | Yes        | Yes             | Lint, test, inspect files at a commit    |
| **Write-capable**  | `resolveRemote` + clone + push       | Yes        | Yes (CAS)       | Agent edits files, commits, pushes back  |

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

`checkoutTo()` writes worktree files to a VFS without any `.git` structure — just the files. `createWorktree()` additionally builds a git index and `.git` scaffold, enabling git commands like `status`, `log`, `diff`, and `show`.

Wrap the repo with `readonlyRepo()` to enforce read-only access — any write operation (`git add`, `git commit`, `git checkout -b`, etc.) will fail with a clear error instead of silently modifying the shared store.

```typescript
// checkoutTo — just the files
const fs = new InMemoryFs();
await checkoutTo(repo, "refs/heads/main", fs, "/workspace");
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

When `GitOptions.objectStore` / `GitOptions.refStore` are provided, they override the filesystem-backed stores that `findGitDir` constructs, so git commands read objects and refs from the shared backend.

### Write-capable agent (resolveRemote + clone)

For agents that need to commit and have those commits safely land in the shared store, the recommended approach is `resolveRemote` — the agent clones into an isolated VFS repo and pushes back. The push goes through `LocalTransport`, which uses `compareAndSwapRef` for concurrent safety.

```typescript
postReceive: async ({ repo, repoPath }) => {
  const git = createGit({
    resolveRemote: () => repo,
    identity: { name: "Agent", email: "agent@ci.dev" },
  });
  const fs = new InMemoryFs();
  const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

  await bash.exec(`git clone local://${repoPath} /repo`);
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

- **`SqliteRefStore`** — wraps read + conditional write in a `db.transaction()`. SQLite's write lock serializes concurrent transactions, making this truly atomic across all callers sharing the same database, even from different `SqliteRefStore` instances.

- **`FileSystemRefStore`** — read-compare-write. Safe for VFS use because the in-memory filesystem has no real I/O concurrency between `await` points.

### Where CAS is used

| Writer                      | CAS expected value                 | Protects against                |
| --------------------------- | ---------------------------------- | ------------------------------- |
| Server receive-pack handler | `oldHash` from client push command | Concurrent HTTP pushes          |
| `LocalTransport.push`       | `oldHash` from `advertiseRefs`     | Concurrent resolveRemote pushes |
| `Platform.mergePullRequest` | `baseSha` read before merge        | Push racing with PR merge       |

All three paths can target the same backing store (e.g. the same SQLite database). CAS at the `RefStore` level ensures correctness regardless of which code path performs the write. The previous `WeakMap<object, Mutex>` in `LocalTransport` was removed — it keyed on JS object identity and couldn't coordinate across different `GitRepo` instances from `SqliteStorage.repo()`.

### Behavior on CAS failure

- **Server handler**: reports `ng <ref> failed to lock` in the report-status response. The client sees a rejected push and can retry.
- **LocalTransport**: reports `failed to lock ref '<ref>'`. The push command surfaces this as a rejected update.
- **Platform merge**: throws `MergeError` with message "base branch was updated concurrently". The caller can retry the merge.

## Future work

- **`atomic` push capability** — all-or-nothing ref updates. Needs a batch CAS method that runs multiple ref swaps in a single SQL transaction. Natural follow-on from per-ref CAS.
- **Server-side GC** — clean up orphaned objects from rejected pushes.
- **Additional presets** — review/merge-request tracking, CI integration, audit logging.
