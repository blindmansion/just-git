# Server Performance Analysis

Baseline measurements from stress-testing the SQLite-backed Git server
(`BunSqliteStorage` + `createStorageAdapter` + `createServer`) against the
[cannoli](https://github.com/DeabLabs/cannoli) repository (~510 commits,
~210 files, 4678 objects, 43 MB raw object data).

## Test setup

- Bun runtime, in-memory SQLite database.
- Source repo cloned from GitHub, pushed to the server, then cloned back.
- Stress test script: `test/perf/server-stress.ts`.

## Baseline (March 2026)

### Upload-pack (clone / fetch serving)

Full clone of the entire repo (0 haves):

| Phase                  | Time          | %        |
| ---------------------- | ------------- | -------- |
| Object enumeration     | ~97 ms        | 6 %      |
| Delta computation      | ~1 400 ms     | **85 %** |
| Pack writing (deflate) | ~112 ms       | 7 %      |
| Protocol + HTTP        | ~30 ms        | 2 %      |
| **Total**              | **~1 650 ms** |          |

Output pack: 2 610 KB (from 43 MB raw), 2 660 deltas out of 4 378 objects.

5 parallel clones: each independently takes ~1 650 ms (wall ~8.5 s).
Every clone recomputes deltas from scratch — identical work repeated 5×.

### Receive-pack (push)

| Operation                                   | Time   |
| ------------------------------------------- | ------ |
| Initial push (4 336 objects, 1 653 KB pack) | 502 ms |
| → readPack (parse + inflate)                | 398 ms |
| → SQLite batch insert                       | 35 ms  |
| Incremental push (150 objects, 14 KB)       | 8 ms   |
| Tag-only push (56 refs, 47 objects)         | 5 ms   |

### End-to-end summary

| Operation                         | Time     |
| --------------------------------- | -------- |
| git clone (from GitHub)           | 545 ms   |
| git push (initial, single branch) | 502 ms   |
| git push --all (all branches)     | 25 ms    |
| git push --tags                   | 52 ms    |
| git clone (from server)           | 2 130 ms |
| 5 parallel clones (wall)          | 8 460 ms |
| push 50 incremental commits       | 60 ms    |
| clone second repo (60 objects)    | 80 ms    |
| git fetch --all (catch up)        | 39 ms    |

---

## Remaining bottlenecks

### Delta computation (85 % of upload-pack)

`findBestDeltas()` in `lib/pack/delta.ts` is the dominant cost.
O(N × W) delta attempts (W=10 default), each scanning kilobytes of
content via rolling-hash. For 4 678 objects that's ~47 000 delta
computations. Mitigated by the pack cache (full clones hit cache after
the first) and the `noDelta` streaming path (skips deltas entirely).

### Object walk — per-object SQLite queries

`enumerateObjectsWithContent()` does one `SELECT` per object.
At ~20 µs per query, 4 678 objects takes ~97 ms — tolerable thanks to
SQLite's speed, but scales poorly for 100k+ object repos.

### No thin pack support

Incremental fetches prune the object walk but don't use client-side
objects as delta bases. Real git's "thin packs" would reduce transfer
size for frequent fetches.

---

## Implemented optimizations

### Pack cache

Added `PackCache` in `operations.ts`, keyed on `(repoId, sorted wants)`
for full-clone requests (0 haves). Integrated into the handler via
`GitServerConfig.packCache`. Defaults to 256 MB limit.

**Impact (cannoli):** 5 parallel clones wall time dropped from ~8.5 s to
~2.1 s (cache hit serves the pack in <1 ms).

### Single-pass inflate

Replaced the binary-search `inflateWithSize` in `lib/pack/packfile.ts`
with `inflateSync(data, { info: true })` via the `inflateWithConsumed`
extension to the `ZlibProvider` in `lib/pack/zlib.ts`. One inflate call
per entry instead of ~13.

**Platform portability:** `{ info: true }` is supported on Bun, Node.js,
and Deno. Cloudflare Workers (`nodejs_compat`) supports `deflateSync`/
`inflateSync` but does not implement the `{ info: true }` option, so
Workers falls back to the binary search (~13 inflate calls per entry).
Feature-detected at startup; browser environments also use the fallback.

**Impact (cannoli, 4 336 objects):**

| Metric             | Before | After  | Speedup  |
| ------------------ | ------ | ------ | -------- |
| `readPack`         | 398 ms | 56 ms  | **7.1×** |
| Initial push total | 502 ms | 153 ms | **3.3×** |

**Impact (SolidJS, 18 804 objects):**

| Metric             | After  |
| ------------------ | ------ |
| `readPack`         | 396 ms |
| SQLite insert      | 211 ms |
| Initial push total | 730 ms |

### Streaming response + configurable deltas

Added `GitServerConfig.packOptions` with `noDelta` and `deltaWindow` fields.
When `noDelta: true`, upload-pack skips delta computation entirely and
returns a `ReadableStream` that pipes objects through a true streaming
pack writer (`writePackStreaming` in `packfile.ts`) and streaming sideband
wrapper (`buildUploadPackResponseStreaming` in `protocol.ts`).

The streaming path reads object content lazily from the store — only one
object is in memory at a time from the pack writer's perspective.

When deltas are enabled (the default), the existing fully-buffered path
with `findBestDeltas` + `writePackDeltified` is used unchanged. The pack
cache continues to work for both modes (cache hits return the buffered
pack instantly regardless of delta config).

**Impact (cannoli, 4 678 objects):**

| Metric                 | Deltas (before) | No-delta streaming | Speedup     |
| ---------------------- | --------------- | ------------------ | ----------- |
| Clone from server      | 1.96 s          | 672 ms             | **2.9×**    |
| Server-side enumerate  | 88 ms           | 74 ms              | —           |
| Server-side delta      | 1 593 ms        | 0 ms               | —           |
| Clone with large files | 2.66 s          | 690 ms             | **3.9×**    |
| Pack size              | 2.6 MB          | 12.3 MB            | 4.7× larger |

**Trade-offs:**

- Pack size is ~4.7× larger without deltas (no OFS_DELTA compression).
  For localhost/LAN serving this is negligible; for WAN, deltas are
  still preferred.
- 5 parallel clones are slightly slower without the pack cache (each
  clone streams independently vs cache hits with deltas). Enable
  `packCache` alongside `noDelta` if repeated identical clones are
  expected.

---

## Future optimizations (deferred)

Not urgent — current numbers are serviceable for the target use case
(sandbox/agent environments, localhost/LAN). Revisit when real usage
data points to a specific bottleneck.

| Fix                   | Impact | Effort | When it matters                                       |
| --------------------- | ------ | ------ | ----------------------------------------------------- |
| E. Batch object reads | ★★★    | Medium | Repos with 50k+ objects; enumeration is 74-97ms today |
| F. Thin packs         | ★★★    | Medium | Frequent incremental fetches of large repos           |
| G. Compressed storage | ★      | Low    | Disk-backed SQLite with large object stores           |
