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

`resolveRemote` already handles in-process, cross-VFS git transport. Multiple isolated VFS agents can clone/fetch/push between each other with zero HTTP overhead. For agents collaborating within a single process, `resolveRemote` is simpler and faster.

The server module adds three things `resolveRemote` can't do:

1. **Real git client access.** A human (or external tool) can `git clone http://your-server/repo`. VS Code, GitHub Desktop, the `git` CLI — anything that speaks git — can interact with server-hosted repos. `resolveRemote` is a closed system; only just-git clients can participate.

2. **Crossing process/network boundaries.** `resolveRemote` requires `GitRepo` instances in the same process (passing object references). The server works over HTTP across machines or deployments.

3. **Decoupled storage backends.** `resolveRemote` requires a VFS with a `.git` directory structure. The server's `GitRepo` is `ObjectStore + RefStore` — backed by SQLite, Postgres, Turso, S3, or anything else. No VFS needed for persistence.

They're complementary: `resolveRemote` for agent-to-agent within a process, the server for persistence and external access.

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

The Smart HTTP protocol surface is small and well-specified. The three endpoints (`info/refs`, `git-upload-pack`, `git-receive-pack`) with protocol v1 are sufficient for any standard git client to clone, fetch, and push. Interop comes from implementing the actual wire protocol.

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

## Current architecture

### Layers

**Layer 1: Protocol primitives** (`protocol.ts`)

Pure functions for building and parsing Git Smart HTTP wire format. No I/O, no state.

- `buildRefAdvertisement` — ref advertisement response body
- `parseUploadPackRequest` / `buildUploadPackResponse` — fetch/clone protocol
- `parseReceivePackRequest` / `buildReportStatus` — push protocol
- `encodeSidebandPacket` — sideband-64k framing

**Layer 1: Operations** (`operations.ts`)

Higher-level functions that combine protocol primitives with storage access.

- `advertiseRefs` — reads refs and objects, builds advertisement
- `handleUploadPack` — parses wants/haves, enumerates objects, builds packfile
- `handleReceivePack` — parses push commands, ingests pack, validates and applies ref updates

These accept `GitRepo` and return response bodies. No HTTP, no framework coupling.

**Layer 2: HTTP handler** (`handler.ts`)

Thin adapter mapping web-standard `Request`/`Response` to the operations layer. Framework-agnostic — works with Bun.serve, Hono, Cloudflare Workers, or anything that speaks fetch API.

**Storage** (`sqlite-storage.ts`)

`SqliteStorage` — multi-repo SQLite backend implementing `ObjectStore` and `RefStore`. Multiple repos partitioned by `repo_id` in a single database.

### Type hierarchy

```
GitRepo { objectStore: ObjectStore, refStore: RefStore, hooks?: HookEmitter }
    └── base type — used by operations.ts and ~35 lib functions directly
    └── server's resolve() callback returns GitRepo

GitContext extends GitRepo { fs, gitDir, workTree, credentialProvider?, ... }
    └── used by command handlers and lib functions that need filesystem access
```

`GitRepo` is the minimal repository handle: sufficient for all pure object/ref operations (read, write, walk, diff trees, merge-base, blame, etc.) without filesystem access. The server module operates entirely through `GitRepo`. The base library's `GitContext` extends it, adding filesystem, paths, and operator-level extensions.

This split is enforced at the type level — lib functions that don't need filesystem access accept `GitRepo`, so calling them from the server is statically safe. No runtime stubs or proxies needed.

### lib/ function split

_Functions accepting `GitRepo` (no filesystem access) — safe for server use:_

- `object-db.ts` — read/write/hash objects (routes through `objectStore`)
- `tree-ops.ts` — `buildTreeFromIndex`, `flattenTree`, `diffTrees`
- `commit-walk.ts` — graph traversal, ahead/behind counts
- `merge.ts` — `findAllMergeBases`, `isAncestor`
- `refs.ts` — `resolveRef`, `readHead`, `resolveHead`, `updateRef`, `createSymbolicRef`, `listRefs`, `advanceBranchRef`
- `blame.ts` — line-level blame
- `rename-detection.ts` — content similarity matching
- `commit-summary.ts` — diffstat computation and formatting
- `patch-id.ts` — patch ID computation
- `transport/object-walk.ts` — reachability enumeration
- `diff-algorithm.ts` — Myers diff
- `diff3.ts` — three-way merge
- `rev-parse.ts` — revision resolution
- `range-syntax.ts`, `date.ts`, `path.ts`

_Functions requiring `GitContext` (filesystem access):_

- `worktree.ts`, `unpack-trees.ts`, `checkout-utils.ts` — working tree
- `index.ts` — staging area (reads `.git/index` file)
- `stash.ts` — reads working tree files
- `config.ts` — reads `.git/config`
- `reflog.ts` — reflog files
- `refs.ts` — `deleteRef`, `writePackedRefs`, `cleanEmptyRefDirs` (filesystem cleanup)
- `operation-state.ts` — `MERGE_HEAD`, `MERGE_MSG`, etc.
- `bisect.ts` — bisect state files
- `ignore.ts` — `.gitignore`

## Design review

### What's strong

**The layered architecture.** Protocol ↔ Operations ↔ HTTP handler is clean. The protocol layer is reusable for non-HTTP transports (SSH, WebSocket, in-process). The operations layer is testable without HTTP.

**The `ObjectStore`/`RefStore` interfaces.** The right abstraction for pluggable storage. The SQLite implementation is solid — prepared statements, transactional pack ingestion, multi-repo partitioning.

**The `GitRepo` / `GitContext` type split.** The server operates on `GitRepo`; lib functions that only need object/ref access accept `GitRepo`; functions requiring filesystem access require `GitContext`. This is enforced by the compiler — no runtime stubs or proxies. The split also makes composition natural: you can build a `GitContext` from a `GitRepo` by adding filesystem parts (see "Working copies in hooks" below).

### What needs work

**The hook model is too thin.**

Current:

```typescript
onPush?: (repoPath: string, refUpdates: RefUpdate[]) => void | Promise<void>;
```

Problems:

- Fires _after_ refs are updated — no ability to reject a push based on content
- Receives only ref names and hashes — no ergonomic way to read commits, diff trees, or inspect files
- No pre-receive equivalent

For the vision of hooks that perform git operations, this needs:

1. **Pre-receive hook** that runs after pack ingestion but before ref updates, with the ability to accept/reject per-ref
2. **A `RepoHandle`** passed into hooks that wraps `GitRepo` and exposes pure git operations ergonomically

Sketch:

```typescript
interface RepoHandle {
  readCommit(hash: string): Promise<Commit>;
  readBlob(hash: string): Promise<Uint8Array>;
  readBlobText(hash: string): Promise<string>;
  diffTrees(a: string, b: string): Promise<TreeDiffEntry[]>;
  flattenTree(hash: string): Promise<FlatTreeEntry[]>;
  log(startHash: string, opts?: { limit?: number }): AsyncIterable<CommitEntry>;
  resolveRef(name: string): Promise<string | null>;
  listRefs(prefix?: string): Promise<RefEntry[]>;
  isAncestor(candidate: string, descendant: string): Promise<boolean>;
  findMergeBases(a: string, b: string): Promise<string[]>;
}
```

This is a thin facade over existing lib functions that all accept `GitRepo`. No new logic needed — just wrapping function calls with a `GitRepo` closure. The type split makes this statically safe: every function `RepoHandle` calls is guaranteed not to touch a filesystem.

Hook model sketch:

```typescript
interface GitServerOptions {
  // ... existing options ...
  onPreReceive?: (ctx: {
    repo: RepoHandle;
    repoPath: string;
    commands: PushCommand[];
  }) => Promise<PreReceiveResult>;
  onPostReceive?: (ctx: {
    repo: RepoHandle;
    repoPath: string;
    refUpdates: RefUpdate[];
  }) => void | Promise<void>;
}
```

**No concurrency safety on ref updates.**

`handleReceivePack` updates refs with bare `writeRef` — no compare-and-swap. Two concurrent pushes to the same ref can race. The `RefStore` interface needs a conditional update primitive:

```typescript
compareAndSwapRef?(name: string, expectedOldHash: string, newRef: Ref): Promise<boolean>;
```

The SQLite implementation would use `UPDATE ... WHERE hash = ?`. The filesystem implementation could use a lock file. Not urgent for single-process use, but needed before production concurrent access.

## Working copies in hooks

Beyond read-only inspection via `RepoHandle`, some hook use cases require a full working tree — running tests against pushed code, having an agent inspect or modify files, running git CLI operations like `gc` or `rebase`.

### How it works

The `GitRepo` / `GitContext` type split makes this compositional. A `GitContext` is just a `GitRepo` plus filesystem parts:

```typescript
import { InMemoryFs } from "just-bash";

async function checkout(repo: GitRepo, ref?: string): Promise<GitContext> {
  const fs = new InMemoryFs();
  const ctx: GitContext = {
    ...repo, // objectStore, refStore, hooks — shared references
    fs,
    gitDir: "/.git",
    workTree: "/",
  };
  // init .git directory structure in the VFS
  // resolve ref (or HEAD), read tree, populate worktree + index
  return ctx;
}
```

The key property is that `objectStore` and `refStore` are **shared references** — the working copy reads from and writes to the same backing store as the server. Blobs checked out come from the real store. Objects created by commits go into the real store. No copying.

This means a hook can:

```typescript
onPostReceive: async ({ repo, repoPath, refUpdates }) => {
  // Read-only inspection — fast, no VFS allocation
  const commit = await repo.readCommit(refUpdates[0].newHash);
  const files = await repo.flattenTree(commit.tree);

  // Or: full working copy for heavier operations
  const ctx = await checkout(repo.raw, "main");
  const git = createGit();
  const bash = new Bash({ cwd: "/", customCommands: [git] });
  await bash.execute("git log --oneline -10");
};
```

### Two tiers of hook capability

| Tier             | API                         | VFS needed      | Use cases                                                                      |
| ---------------- | --------------------------- | --------------- | ------------------------------------------------------------------------------ |
| **Inspection**   | `RepoHandle`                | No              | Read commits, diff trees, read file contents, check ancestry, enforce policies |
| **Working copy** | `checkout()` → `GitContext` | Yes (in-memory) | Run tests, execute scripts, run git CLI commands, agent file inspection        |

Most hooks only need the inspection tier. The working copy tier is an escape hatch for heavier operations.

### Considerations for working copies

**Config.** A `GitContext` composed from a `GitRepo` + temp VFS starts with an empty `.git/config`. Commands that read config (`user.name`, `merge.ff`, etc.) will use defaults or fall back to env vars. The `checkout()` helper should accept optional config values to inject, or the caller can write a config file into the VFS.

**Concurrency.** A working copy shares the backing `objectStore` and `refStore`. Concurrent operations (multiple hooks running simultaneously, or a hook running alongside a push) could race on ref updates. The same CAS primitive needed for concurrent pushes also applies here. For the `ObjectStore`, writes are append-only (content-addressed), so concurrent object writes are safe. Ref updates are the contention point.

**Memory.** In-memory working copies consume memory proportional to the repo's checked-out file tree. For the target use case (agent-sized repos), this is fine. For large repos, consider that the working copy only needs to exist for the duration of the hook.

**Which CLI commands work.** Commands that only read objects and refs (`log`, `show`, `diff <commit> <commit>`, `rev-parse`, `blame`, `branch -v`) work directly because they go through `objectStore`/`refStore`. Commands that touch the worktree (`add`, `commit`, `checkout`, `status`) work because the VFS provides the filesystem layer. Commands like `gc` are storage-backend-specific — `gc` repacks loose objects in `PackedObjectStore` (VFS-backed), which doesn't apply to `SqliteStorage`. Storage backends may need their own maintenance operations.

## Next steps (rough priority)

1. **`RepoHandle` facade** — wrap the `GitRepo`-accepting lib functions in an ergonomic object interface. This is the key API that makes server hooks feel like application code.

2. **Pre-receive hook** — fire after pack ingestion, before ref updates. Pass `RepoHandle` so the hook can inspect what's being pushed and accept/reject per-ref.

3. **Post-receive with `RepoHandle`** — replace `onPush` with a richer `onPostReceive` that passes the handle.

4. **`checkout()` helper** — compose a `GitContext` from a `GitRepo` + temp VFS, populate the worktree from a ref. Enables full git operations inside hooks.

5. **Ref CAS** — add `compareAndSwapRef` to `RefStore` and use it in `handleReceivePack`. Becomes more important once hooks can write refs.
