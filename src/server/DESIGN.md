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

2. **Crossing process/network boundaries.** `resolveRemote` requires GitContexts in the same process (passing object references). The server works over HTTP across machines or deployments.

3. **Decoupled storage backends.** `resolveRemote` requires a VFS with a `.git` directory structure. The server's `ServerRepoContext` is `ObjectStore + RefStore` — backed by SQLite, Postgres, Turso, S3, or anything else. No VFS needed for persistence.

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

| Feature | Matters for agents? |
|---|---|
| Protocol v2 | No — v1 works, clients fall back |
| Shallow clones (`--depth`) | Rarely — agent repos are small |
| Partial clones (`--filter`) | No |
| SSH transport | No — bearer token auth over HTTP is better for agents |
| LFS | Unlikely for now |
| Delta compression in server-generated packs | Performance optimization, not correctness |

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

These accept `ServerRepoContext` and return response bodies. No HTTP, no framework coupling.

**Layer 2: HTTP handler** (`handler.ts`)

Thin adapter mapping web-standard `Request`/`Response` to the operations layer. Framework-agnostic — works with Bun.serve, Hono, Cloudflare Workers, or anything that speaks fetch API.

**Storage** (`sqlite-storage.ts`)

`SqliteStorage` — multi-repo SQLite backend implementing `ObjectStore` and `RefStore`. Multiple repos partitioned by `repo_id` in a single database.

### Type hierarchy

```
ServerRepoContext { objects: ObjectStore, refs: RefStore }
    └── used by operations.ts, bridged to GitContext via toGitContext()

GitContext { fs, gitDir, workTree, objectStore?, refStore?, hooks?, ... }
    └── used by all lib/ functions
```

## Design review

### What's strong

**The layered architecture.** Protocol ↔ Operations ↔ HTTP handler is clean. The protocol layer is reusable for non-HTTP transports (SSH, WebSocket, in-process). The operations layer is testable without HTTP.

**The `ObjectStore`/`RefStore` interfaces.** The right abstraction for pluggable storage. The SQLite implementation is solid — prepared statements, transactional pack ingestion, multi-repo partitioning.

**The lib/ function split is favorable for server-side use.** Tracing `ctx.fs` usage across all of `lib/` reveals a clean divide:

*Pure object/ref operations (no filesystem access) — safe for server use:*
- `object-db.ts` — read/write/hash objects (routes through `objectStore`)
- `tree-ops.ts` — `buildTreeFromIndex`, `flattenTree`, `diffTrees`
- `commit-walk.ts` — graph traversal, ahead/behind counts
- `merge.ts` — `findAllMergeBases`, `isAncestor`
- `diff-algorithm.ts` — Myers diff
- `diff3.ts` — three-way merge
- `rev-parse.ts` — revision resolution
- `rename-detection.ts` — content similarity
- `transport/object-walk.ts` — reachability enumeration
- `patch-id.ts`, `range-syntax.ts`, `date.ts`, `path.ts`

*Filesystem-dependent operations — require VFS, not available server-side:*
- `worktree.ts`, `unpack-trees.ts`, `checkout-utils.ts` — working tree
- `index.ts` — staging area (reads `.git/index` file)
- `stash.ts` — reads working tree files
- `config.ts` — reads `.git/config`
- `reflog.ts` — reflog files
- `operation-state.ts` — `MERGE_HEAD`, `MERGE_MSG`, etc.
- `bisect.ts` — bisect state files
- `ignore.ts` — `.gitignore`

All the operations you'd want for server-side introspection are in the pure category.

### What needs work

**`toGitContext` is a fragile bridge.**

The current bridge from `ServerRepoContext` to lib functions:

```typescript
const STUB_FS = new Proxy({} as FileSystem, {
  get(_, prop) {
    return () => { throw new Error(`FileSystem.${String(prop)} is not available`); };
  },
});

function toGitContext(repo: ServerRepoContext): GitContext {
  return { fs: STUB_FS, gitDir: "/.git", workTree: null, objectStore: repo.objects, refStore: repo.refs };
}
```

This works today because the server only calls `enumerateObjectsWithContent` and `isAncestor`, both pure operations. But it's a runtime landmine — any lib function that transitively touches `ctx.fs` will throw an opaque proxy error. No compile-time safety. As more lib functions get called from server hooks, this will break in unexpected ways.

**Root cause:** `GitContext` conflates object/ref storage with filesystem/worktree context. Server-side repos need the former without the latter.

**Potential direction:** Extract a `RepoContext` type that contains just `objectStore`, `refStore`, and `hooks`. The pure lib functions would accept this narrower type. `GitContext` would extend it, adding `fs`, `gitDir`, `workTree`, etc. This is a type-level change — the functions don't change behavior, just their parameter type narrows. It would make the server-safe subset statically verifiable.

**The hook model is too thin.**

Current:
```typescript
onPush?: (repoPath: string, refUpdates: RefUpdate[]) => void | Promise<void>;
```

Problems:
- Fires *after* refs are updated — no ability to reject a push based on content
- Receives only ref names and hashes — no ergonomic way to read commits, diff trees, or inspect files
- No pre-receive equivalent

For the vision of hooks that perform git operations, this needs:

1. **Pre-receive hook** that runs after pack ingestion but before ref updates, with the ability to accept/reject per-ref
2. **A repo handle** passed into hooks that wraps storage and exposes pure git operations ergonomically

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

This is the API surface that would make writing a server hook feel like application code rather than git plumbing. All the underlying primitives exist in `lib/` — this is a facade, not new logic.

Hook model sketch:
```typescript
interface GitServerOptions {
  // ... existing options ...
  onPreReceive?: (ctx: { repo: RepoHandle; repoPath: string; commands: PushCommand[] }) =>
    Promise<PreReceiveResult>;
  onPostReceive?: (ctx: { repo: RepoHandle; repoPath: string; refUpdates: RefUpdate[] }) =>
    void | Promise<void>;
}
```

**No concurrency safety on ref updates.**

`handleReceivePack` updates refs with bare `writeRef` — no compare-and-swap. Two concurrent pushes to the same ref can race. The `RefStore` interface needs a conditional update primitive:

```typescript
compareAndSwapRef?(name: string, expectedOldHash: string, newRef: Ref): Promise<boolean>;
```

The SQLite implementation would use `UPDATE ... WHERE hash = ?`. The filesystem implementation could use a lock file. Not urgent for single-process use, but needed before production concurrent access.

## Next steps (rough priority)

1. **`RepoHandle` facade** — expose the pure lib operations through an ergonomic interface that hooks can use. This is the key API that makes the server interesting.

2. **Pre-receive hook** — fire after pack ingestion, before ref updates. Pass `RepoHandle` so the hook can inspect what's being pushed.

3. **Type split (`RepoContext`)** — extract the object/ref subset from `GitContext` so the pure lib functions have a narrower parameter type. Eliminates the `STUB_FS` hack and makes server-safe operations statically verifiable.

4. **Ref CAS** — add `compareAndSwapRef` to `RefStore` and use it in `handleReceivePack`.

5. **Post-receive with `RepoHandle`** — replace `onPush` with a richer `onPostReceive` that passes the handle.
