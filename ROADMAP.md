# Roadmap

Three workstreams, ordered by dependency. Each phase produces shippable, testable improvements — no phase is wasted work if priorities shift.

## Phase 1: Streaming transfer pipeline

**Goal**: The object enumeration → pack writing → pack ingestion pipeline currently materializes all objects in memory at once. Rework it to stream, and wire up delta compression for transport. This is the foundation everything else builds on.

**Why first**: This pipeline is the hottest path for both the server (`handleUploadPack`, `handleReceivePack`) and the client (`LocalTransport`, `SmartHttpTransport`). The server API (Phase 2) wraps these operations — building a compelling API on top of a pipeline that OOMs on medium repos undermines the product. Delta compression for transport ("slim packs") requires reworking this same pipeline, so doing both together avoids touching it twice.

**What changes**:

- `enumerateObjects` / `enumerateObjectsWithContent` → async iterator variants that yield objects one at a time instead of accumulating an array
- `writePack` / `writePackDeltified` → accept async iterables, write entries as they arrive
- `readPack` → streaming variant that yields entries incrementally for pack ingestion
- Wire `writePackDeltified` into transport paths (server upload-pack, `LocalTransport`, `SmartHttpTransport` push) so packs are delta-compressed
- Add a bounded object cache to `PackedObjectStore` / `object-db` to avoid re-inflating the same hash repeatedly during walks
- Lazy pack discovery in `PackedObjectStore` — load `.pack`/`.idx` on demand rather than all at once

**Detailed plan and results**: [PHASE1.md](PHASE1.md)

**Status**: Complete. All transport paths use delta-compressed packs. Object cache is type-aware (trees/commits only) with FIFO eviction. Lazy pack discovery defers `.pack` loading. `ObjectStore.invalidatePacks()` keeps state consistent after repack/gc. VFS perf improved 5–14% across oracle profiles with no regressions. Step 4 (streaming pack ingestion) was cancelled — delta resolution and batch store writes limit the practical memory savings.

## Phase 2: Server API

**Goal**: Build the hook model and ergonomic API layer described in [`src/server/DESIGN.md`](src/server/DESIGN.md). This is the primary product-facing work — it turns the server from a protocol implementation into a programmable platform.

**Why second**: `RepoHandle` is a thin facade over `GitRepo`-accepting lib functions — its design is stable regardless of internal memory changes. But the _operations_ it exposes (tree diffs, commit walks, object reads) should be efficient before users write hooks against them. Phase 1 ensures that a hook calling `repo.diffTrees()` on a large push doesn't flatten two full trees into memory.

**What changes**:

- `RepoHandle` — ergonomic object wrapping the `GitRepo`-accepting lib functions (`readCommit`, `readBlob`, `diffTrees`, `flattenTree`, `log`, `resolveRef`, `listRefs`, `isAncestor`, `findMergeBases`)
- Pre-receive hook — fires after pack ingestion, before ref updates. Receives `RepoHandle` + push commands. Can accept/reject per-ref
- Post-receive with `RepoHandle` — replaces the current `onPush` callback
- `checkout()` helper — compose a `GitContext` from a `GitRepo` + temp VFS, populate worktree from a ref. Enables full git CLI operations inside hooks
- Ref CAS — `compareAndSwapRef` on `RefStore`, used by `handleReceivePack`. Needed for concurrent push safety and once hooks can write refs

**Depends on**: Phase 1 (streaming pipeline, object cache). The API design itself is independent, but the performance characteristics matter for user experience.

**Phase 1 findings relevant to Phase 2**:

- `findBestDeltas` currently needs the full object list in memory for windowed comparison. For server hooks that inspect push content, this means the objects are available as an array — `RepoHandle` or pre-receive hooks can expose this directly rather than re-reading.
- The object cache is tuned for trees/commits (skips blobs). Server hooks doing blob-heavy operations (e.g. scanning file content in pre-receive) will go through the store uncached. Consider whether `RepoHandle.readBlob()` should offer an optional content cache for hook use cases.
- `invalidatePacks()` must be called by any server-side operation that rewrites packs. The pre/post-receive hook lifecycle should account for this — if a hook triggers gc/repack, downstream operations need consistent object store state.
- Perf test script `test/perf/large-repo.ts` clones real repos and exercises hot paths. Useful for validating Phase 2 API performance on real data.

## Phase 3: Protocol v2 and further optimization

**Goal**: Implement Git protocol v2 for both client and server, and address remaining memory patterns for large-repo support.

**Why last**: Protocol v1 works and clients fall back transparently. The v2 wire format is a mechanical change — the performance wins that matter (delta packs, streaming) are delivered in Phase 1. The remaining optimizations (tree streaming, index partial loading) only matter for very large repos, which aren't the primary target use case.

**What changes**:

Protocol v2:

- v2 capability advertisement and `ls-refs` / `fetch` command framing (client and server)
- More efficient negotiation — server-side ref filtering, no capability line on first want
- Thin-pack support — server sends packs with delta bases the client already has (requires the streaming pack writer to know the have set)

Remaining optimizations:

- Tree operation streaming — incremental traversal for `diffTrees` and `unpack-trees` instead of full `flattenTreeToMap`
- Index partial loading — avoid materializing the full entry array for read-only queries
- HTTP fetch response streaming — process pack data as it arrives instead of `await res.arrayBuffer()`
- Streaming pack ingestion — deferred from Phase 1. Could reduce memory during large pushes if delta resolution is reworked to stream base lookups. Lower priority than the items above.
- Object walk async overhead — the recursive `walkReachable` / `collectMissing` pattern does one `await readObject()` per object. On solid.js (22K objects), this is ~2s of wall time dominated by microtask scheduling. A batched or synchronous walk for VFS-backed stores could cut this significantly.

Lib/server boundary:

- Audit functions that require `GitContext` but could accept `GitRepo`. Widen signatures where safe
- Ensure new streaming interfaces work identically for `PackedObjectStore` (VFS) and `SqliteStorage` (server)

**Depends on**: Phase 1 (streaming infrastructure), Phase 2 (server API stability). Some items (tree streaming, index work) are independent and could be pulled forward if needed.

## Cross-cutting concerns

These apply across all phases:

- **Breaking changes are fine.** The library is new — there are no external consumers to worry about. If a cleaner API means changing function signatures, removing old interfaces, or rewriting tests that reached into internals, do it. Prefer the clean result over compatibility shims.
- **Test coverage**: Each change needs tests. The oracle test suite validates end-to-end correctness. Server roundtrip tests verify interop. Tests that reach into changed internals should be rewritten to match the new design, not preserved with adapters.
- **`SqliteStorage` parity**: Every interface change to `ObjectStore` must be implemented in both `PackedObjectStore` and `SqliteStorage`.
- **Storage modality awareness**: Changes to core interfaces affect multiple storage backends — in-memory VFS (browser/agent use), SQLite (server), real filesystem (possible but less likely), IndexedDB (future browser). See [BASELINE.md](BASELINE.md) for analysis of how Phase 1 changes interact with each modality.
- **Benchmarking**: Baseline performance is recorded in [BASELINE.md](BASELINE.md). After each phase, re-run the same profiling suite to verify no regressions for the VFS path. The server roundtrip tests provide end-to-end timing for the SQLite path.
