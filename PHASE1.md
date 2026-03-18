# Phase 1: Streaming Transfer Pipeline

Rework the object enumeration → pack writing → pack ingestion pipeline from batch-and-accumulate to streaming, and enable delta compression for all transport paths.

## Problem

The current transfer pipeline materializes all objects in memory at once. For a clone/fetch serving N objects:

1. `enumerateObjectsWithContent` walks the object graph and accumulates every missing object (with full content) into a single `WalkObjectWithContent[]` array
2. That array is mapped to a `PackInput[]` array (second copy of all content references)
3. `writePack` iterates the array and deflates each entry into chunks, then concatenates everything into a single `Uint8Array`

Peak memory is roughly 2× the total uncompressed object content, plus the final compressed pack. For `LocalTransport.fetch`, there's an additional step: `enumerateObjects` returns hashes only, then each object is re-read from the store (re-inflating from pack or loose) to build `packInputs`.

The server's `handleUploadPack` follows the same pattern (lines 123–154 of `operations.ts`). `handleReceivePack` ingests packs via `objectStore.ingestPack`, which for `PackedObjectStore` calls `buildPackIndex` → `readPack`, materializing all entries to build the index.

All transport packs are undeltified (`writePack`), despite `writePackDeltified` existing and being tested. A 10 MB repo transfers 10 MB of uncompressed objects instead of ~3-4 MB of delta-compressed data.

## Steps

### 1. Async iterator variants for object enumeration

**Files**: `src/lib/transport/object-walk.ts`

Add `enumerateObjectsStream` and `enumerateObjectsWithContentStream` that return `AsyncIterable` instead of arrays. The walk logic is the same — the difference is `yield` instead of `result.push()`.

```typescript
export async function* enumerateObjectsWithContentStream(
  ctx: GitRepo,
  wants: ObjectId[],
  haves: ObjectId[],
): AsyncIterable<WalkObjectWithContent> { ... }
```

The `haveSet` still needs to be fully built before yielding (we need to know the full "already known" set before walking wants). The memory savings come from not accumulating the want-side results.

The existing array-returning functions can be replaced outright — backward compatibility is not a concern. If callers need the array form, they can collect the iterator. Prefer the cleaner API.

**Tests**: Verify that the iterator variant produces the same objects in the same order as the array variant, for various graph shapes (linear, branching, tags, shared subtrees).

### 2. Streaming pack writer

**Files**: `src/lib/pack/packfile.ts`

Add overloads or new functions that accept `AsyncIterable<PackInput>` instead of `PackInput[]`.

Challenge: the pack header requires the object count upfront (bytes 8–11). Two options:

- **Two-pass**: iterate once to count, then again to write. Requires the iterable to be re-consumable, which defeats streaming.
- **Buffer header, patch count**: write a placeholder count, stream all entries, then patch the count in the final buffer. Since we concatenate chunks at the end anyway, we can update the header chunk before final assembly.
- **Pre-counted**: accept a `count` parameter alongside the iterable. The caller knows the count from the walk (the walk knows how many objects it will yield because it builds the visited set before yielding). This is the simplest approach.

Recommendation: pre-counted. `enumerateObjectsWithContentStream` can return `{ count: number, objects: AsyncIterable<...> }` since it builds the full visited set in the have-walk phase before yielding.

For `writePackDeltified`, the delta window needs to see recent objects for base selection. This already works with the current `findBestDeltas` approach — the delta computation happens before pack writing. The streaming change here is about not requiring all _pack entries_ in memory at once, not about streaming the delta search.

**Tests**: Round-trip test — stream-write a pack, read it back with `readPack`, verify all objects match. Compare output byte-for-byte with the array-based `writePack` for the same inputs.

### 3. Wire up deltified packs for transport

**Files**: `src/server/operations.ts`, `src/lib/transport/transport.ts`

Replace `writePack(packInputs)` with `writePackDeltified(deltaInputs)` in:

- `handleUploadPack` (server serving fetch/clone)
- `LocalTransport.fetch` (in-process fetch)
- `LocalTransport.push` (in-process push)
- `SmartHttpTransport.push` (HTTP push — `buildPushBody` in `smart-http.ts`)

The `writePackDeltified` path needs `DeltaPackInput[]` with hash, type, content, and optional delta/deltaBaseHash fields. The `findBestDeltas` function (in `delta.ts`) computes optimal deltas given a list of objects. The flow becomes:

1. Enumerate objects (streaming or collected)
2. Run `findBestDeltas` over the collected objects to compute delta instructions
3. Write pack with `writePackDeltified`

Note: `findBestDeltas` currently needs the full object list to do windowed comparison. This is acceptable — delta computation is inherently batch. The streaming win is in the _write_ phase (not holding both the input array and the output pack simultaneously).

For the server path, this means `handleUploadPack` will produce significantly smaller packs. For `LocalTransport`, the benefit is smaller pack files stored on the receiving side.

**Tests**: Server roundtrip tests (`test/server/roundtrip.test.ts`, `test/server/real-git.test.ts`) verify that real git clients can still clone/fetch from deltified packs. Oracle test suite verifies that `LocalTransport` clone/fetch/push still produces correct repos.

### 4. Streaming pack ingestion

**Files**: `src/lib/pack/packfile.ts`, `src/lib/object-store.ts`, `src/server/sqlite-storage.ts`

`readPack` currently returns `PackObjectMeta[]` — all entries fully resolved. For pack ingestion, we only need to iterate entries and write them to the store. Add a streaming variant:

```typescript
export async function* readPackStream(
  data: Uint8Array,
  externalBase?: ExternalBaseResolver,
): AsyncIterable<PackObjectMeta> { ... }
```

Challenge: OFS_DELTA entries reference earlier entries by byte offset. The current implementation stores all resolved entries in an array indexed by position. A streaming variant needs a map from offset → resolved content for delta bases that have been yielded. Since delta bases are always earlier in the pack, this works with a sliding window — but we can't discard bases until we know no later entry references them. In practice, most packs are ordered so bases appear shortly before their deltas. A bounded cache of recently-yielded entries (by offset) handles this.

`PackedObjectStore.ingestPack` and `SqliteStorage.ingestPack` would consume the iterator, writing objects one at a time instead of materializing the full entry list.

The `buildPackIndex` path still needs all entries for index construction (it needs offsets and CRC32 for every entry). This can use the streaming reader internally but must retain the metadata. The actual object _content_ doesn't need to be kept after hashing and CRC computation.

**Tests**: Ingest a pack via streaming, verify all objects are readable. Compare with batch ingestion results.

### 5. Object cache

**Files**: `src/lib/object-store.ts`, `src/lib/object-db.ts`

Add a bounded LRU cache for object reads. During a walk, the same tree objects are often read multiple times (e.g., the have-walk reads a tree, then the want-walk reads the same tree for diffing). Without a cache, each read re-inflates from pack or loose storage.

Two options for where to cache:

- **`PackedObjectStore` level**: cache raw `RawObject` results in `read()`. Simple, catches all reads. But `SqliteStorage` wouldn't benefit (it has its own `read`).
- **`object-db` level**: cache in `readObject()` / `readBlobContent()`. Catches both store implementations. But `object-db` is stateless functions, not a class — would need to thread a cache through or make it a class.

Recommendation: cache at the `ObjectStore` level. Add an optional `cache?: ObjectCache` to the store implementations. `PackedObjectStore` gets a built-in LRU. `SqliteStorage` can add one too (SQLite has its own page cache, but avoiding the roundtrip is still worthwhile).

Size the cache by total content bytes, not entry count. A 16 MB default covers most tree + commit objects in a typical walk without holding large blobs.

**Tests**: Verify cache hits/misses with a mock store. Verify that cached reads return identical results to uncached reads. Benchmark a full object walk (e.g., `enumerateObjectsWithContent` on a stress-test repo) with and without cache.

### 6. Lazy pack discovery

**Files**: `src/lib/object-store.ts`

`PackedObjectStore.doDiscover` reads every `.pack` and `.idx` file into memory at first access. For repos with many packs (before `gc`/`repack`), this loads megabytes of pack data that may never be queried.

Change to lazy loading:

1. On discover, scan the pack directory for `.idx` files but only load the index data (not the pack data). Pack indices are small (32 bytes per object + fanout table).
2. When a read hits a pack index match, load the corresponding `.pack` file on demand.
3. Optionally: keep a limited number of `.pack` files loaded, evicting the least-recently-used.

This means `PackReader` needs to support deferred pack loading — construct with just the index, load pack data on first `readObject` call.

**Tests**: Verify that objects are still found correctly with lazy loading. Test with multiple packs where the target object is in the last pack discovered. Benchmark discovery time with many packs.

## Ordering within Phase 1

Steps 1–3 form a dependency chain: streaming enumeration → streaming pack write → deltified transport. Do them in order.

Steps 4–6 are independent of each other and of 1–3. They can be interleaved or done in parallel.

Suggested order: **1 → 2 → 3 → 5 → 4 → 6**

The object cache (5) before streaming ingestion (4) is because the cache improves walk performance immediately, while streaming ingestion is a memory optimization for the receive path (less urgent than the send path which steps 1–3 address). Lazy pack discovery (6) is lowest priority — it only matters for repos with many un-repacked packs.

## Non-goals for Phase 1

- **Protocol v2 wire format** — Phase 3. The streaming infrastructure built here enables it, but the wire format change is separate.
- **Tree operation streaming** (`diffTrees`, `flattenTree`) — Phase 3. These are memory-heavy but not on the transfer hot path.
- **Index partial loading** — Phase 3. Only matters for very large worktrees.
- **HTTP response streaming** — Phase 3. The client's `await res.arrayBuffer()` is a problem for large fetches, but the server side (which we control) benefits from streaming pack _generation_ (steps 1–3) without needing to stream the HTTP response itself.
- **Thin-pack support** — Phase 3. Requires the pack writer to reference objects not in the pack (REF_DELTA with external bases). Delta compression within the pack (OFS_DELTA, step 3) is the higher-value change.

## Validation

- Oracle test suite (`bun oracle validate`) confirms end-to-end correctness for the VFS path. Tests that reach into changed internals should be rewritten, not preserved with shims — backward compatibility is not a concern.
- Server roundtrip tests confirm interop with real git for the HTTP path
- Profiling baselines are recorded in [BASELINE.md](BASELINE.md). Re-run after Phase 1 to verify no regressions for the VFS path and measure improvements.
- `bun test` for unit tests — rewrite any that break due to interface changes

## Results

Phase 1 is complete. All steps executed except step 4 (streaming pack ingestion), which was cancelled after analysis showed minimal practical benefit.

### What shipped

**Steps 1–3 (streaming + deltified transport):**

- `enumerateObjects` and `enumerateObjectsWithContent` now return `EnumerationResult<T>` with `{ count, objects: AsyncIterable<T> }`. Content is read lazily during iteration. A `collectEnumeration` helper converts to array when callers need the full list (e.g. for `findBestDeltas`).
- `writePackStream` and `writePackDeltifiedStream` accept `(count, AsyncIterable<PackInput>)` for incremental pack building.
- All transport paths (`LocalTransport.fetch`, `LocalTransport.push`, `SmartHttpTransport.push`, server `handleUploadPack`) now produce delta-compressed packs via `findBestDeltas` + `writePackDeltified`. A shared `buildDeltifiedPack` helper in `transport.ts` encapsulates the enumerate → deltify → pack flow.

**Step 4 (streaming pack ingestion) — cancelled:**

Delta resolution inherently requires base objects in memory for OFS_DELTA chains. `PackedObjectStore` retains packs as whole units on disk (not individual objects), and `SqliteObjectStore` wraps inserts in batch transactions. The memory savings from streaming ingestion would be marginal. Skipping this avoided complexity without sacrificing the goals.

**Step 5 (object cache):**

`ObjectCache` in `src/lib/object-cache.ts`, integrated into both `PackedObjectStore` and `SqliteObjectStore`. Initial implementation used byte-bounded LRU. Post-Phase 1 profiling revealed cache thrashing on larger repos (see below), leading to a revised design:

- **Type-aware**: only caches `tree`, `commit`, and `tag` objects. Blobs are skipped entirely — they are large, rarely re-read within a single operation, and would thrash smaller objects out of cache.
- **FIFO eviction** instead of LRU: avoids the `Map.delete` + `Map.set` bookkeeping on every cache hit that made LRU a net-negative on VFS backends where reads are already cheap.
- Default 16 MB budget. With blob-skipping, this comfortably holds all trees and commits for repos up to ~50K objects (cannoli: 2559 entries in 843 KB; solid.js: 13,464 entries in 4.8 MB).

**Step 6 (lazy pack discovery):**

`PackedObjectStore.doDiscover` now loads only `.idx` files (creating `PackIndex` objects) and defers loading `.pack` data until an object from that pack is actually read. `PackReader` constructor accepts a pre-parsed `PackIndex`. A `PackSlot` interface tracks per-pack state (name, index, optional reader). `ensureReader` loads pack data on demand.

### Additional fixes

**`ObjectStore.invalidatePacks()`**: After `git repack` or `git gc` rewrites pack files, the object store's cached discovery state becomes stale. Added `invalidatePacks()` to the `ObjectStore` interface (optional method). `PackedObjectStore` implements it by clearing `packs`, `loadedPackNames`, `discoverPromise`, and the object cache. `repackFromTips` calls it after writing new packs. Without this, reads after repack could fail with "object not found".

### Performance vs baseline (VFS)

Measured on the same oracle datasets and machine as [BASELINE.md](BASELINE.md). Perf test script: `test/perf/large-repo.ts`.

**Oracle profiles (wall time):**

| Dataset                           | Baseline | Post Phase 1 | Change   |
| --------------------------------- | -------- | ------------ | -------- |
| core-test (5 traces, 1738 steps)  | 2.2s     | 1.9s         | **-14%** |
| core3 trace 1 (1665 steps)        | 3.9s     | 3.7s         | **-5%**  |
| kitchen6 (10 traces, 12007 steps) | 17.1s    | 16.2s        | **-5%**  |

**Per-command highlights:**

| Command         | Baseline mean | Post Phase 1 mean | Change               |
| --------------- | ------------- | ----------------- | -------------------- |
| git rebase      | 4.33ms        | 3.56ms            | **-18%** (core-test) |
| git cherry-pick | 1.99ms        | 1.76ms            | **-11%** (core-test) |
| git add         | 0.93ms        | 0.80ms            | **-14%** (core-test) |
| git gc          | 117ms         | 117ms             | same (kitchen6)      |

No regressions. gc/repack delta compression CPU cost is offset by cache improvements in other operations. Repo size growth is identical to baseline (expected — size depends on walk content, not the transfer pipeline).

**Large repo test (solid.js, 22,799 objects):**

| Operation                               | Time  |
| --------------------------------------- | ----- |
| git clone (HTTP)                        | 4.4s  |
| Full object enumeration                 | 3.9s  |
| git rebase (20 commits on real history) | 57ms  |
| git repack -a -d                        | 11.5s |
| git blame (single file)                 | 137ms |

### Lessons learned

- **Cache type awareness matters more than cache size.** The initial 16 MB LRU cache thrashed on repos > 4K objects because blobs crowded out trees/commits. The fix (skip blobs, FIFO eviction) reduced cache memory from 16 MB to < 5 MB while increasing the entry count from 1,535 to 13,464 on solid.js.
- **VFS reads are cheap enough that cache overhead can exceed savings.** LRU promotion (`Map.delete` + `Map.set` on every hit) was measurably expensive at scale. FIFO avoids this. For SQLite/real-FS backends the calculus is different — even a thrashing cache saves expensive I/O.
- **Streaming pack ingestion has diminishing returns.** Delta resolution requires holding base content in memory, and both object store implementations already buffer writes (VFS in memory, SQLite in transactions). The streaming enumeration and pack _writing_ steps provide the bulk of the memory benefit.
- **Pack file rewrites require store invalidation.** Any operation that externally modifies `.git/objects/pack/` (repack, gc) must signal the object store to discard cached state. The `invalidatePacks()` method provides this.
