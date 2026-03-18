# Server Performance Analysis

Baseline measurements from stress-testing the SQLite-backed Git server
(`SqliteStorage` + `createGitServer`) against the
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

## Bottleneck analysis

### 1. Delta computation (85 % of upload-pack)

`findBestDeltas()` in `lib/pack/delta.ts` is the dominant cost.

For each of N objects with a sliding window of W (default 10):

- Builds a Rabin fingerprint index of the object's content.
- Tries up to W preceding same-type objects as delta bases via
  `createDelta()`, which does a full rolling-hash scan of the target.

This is O(N × W) delta attempts, each scanning kilobytes of content.
For 4 678 objects that's up to ~47 000 delta computations.

The result is **recomputed from scratch on every request**. Parallel
clones do identical work independently.

### 2. ~~No response streaming~~ — fixed (no-delta path)

~~`handleUploadPack()` returns a `Uint8Array` — the entire pack is
materialized in memory before a single byte is sent.~~

Fixed for the no-delta path: `handleUploadPack` returns a
`ReadableStream` that pipes objects through `writePackStreaming` and
`buildUploadPackResponseStreaming`. The deltified path remains buffered
(delta computation requires all objects upfront).
See "Implemented optimizations → C + D" below.

### 3. Object walk — per-object SQLite queries

`enumerateObjectsWithContent()` traverses the commit graph recursively.
Each `readObject()` and `objectExists()` call is a separate SQLite
`SELECT`. For 4 678 objects that's 4 678+ individual queries during the
want walk, plus more for the have-side.

At ~97 ms total (~20 µs per query) this is tolerable thanks to SQLite's
speed, but it would scale poorly for repos with 100k+ objects.

The `ObjectCache` helps for commits/trees on re-reads, but every object
is read at least once, and blobs are never cached.

### 4. ~~`inflateWithSize` binary search in pack reader~~ — fixed

~~`readPack()` used O(N × log(compressed)) inflate calls per entry.~~

Fixed: single-pass inflate via `inflateSync(data, { info: true })`.
See "Implemented optimizations → B" above.

### 5. No thin pack support

When a client sends `have` hashes (incremental fetch), the server
correctly prunes the object walk but does not use client-side objects as
delta bases. Real git supports "thin packs" where delta instructions can
reference objects the client already owns, significantly reducing
transfer size for incremental fetches.

### 6. Protocol v1 only

The server implements Smart HTTP Protocol v1. Protocol v2 would add:

- **Ref filtering** (`ls-refs`): clients request only matching refs
  instead of receiving all 72.
- **Stateless fetch**: better suited for HTTP/2 and streaming.
- **Object filtering**: partial clones (`blob:none`, `tree:N`).
- **Server-side ref prefix filtering**: reduces overhead for repos with
  many thousands of refs.

Not a performance necessity at current repo sizes, but important for
ecosystem compatibility.

---

## Possible optimizations

### A. Pack cache (high impact, moderate effort)

Cache the generated packfile per repo, keyed on the sorted set of ref
tip hashes. When refs haven't changed since the last pack was built,
serve the cached bytes directly — no enumeration, no deltas, no
compression.

Expected impact: parallel clones drop from ~8.5 s wall to ~200 ms.
Incremental fetches still need fresh computation (different want/have
sets), but full clones become nearly free.

Invalidation: any ref update (push) invalidates the cache for that repo.
Cache can be in-memory (bounded LRU) or written to a `.pack` file on
disk alongside the SQLite database.

### B. Fix `inflateWithSize` (high impact, low effort)

Replace the binary-search approach with `node:zlib`'s streaming
`Inflate` class or Bun's `inflateSync` which can report bytes consumed.
The `Z_SYNC_FLUSH` / `Z_FINISH` return value tells you exactly where the
compressed stream ended.

Expected impact: `readPack` for the initial push drops from ~398 ms to
~50-100 ms (single inflate pass per entry instead of ~13 per entry).

### ~~C. Streaming response~~ — implemented

### ~~D. Configurable delta compression~~ — implemented

See "Implemented optimizations → C + D" below.

### E. Batch object reads (moderate impact, moderate effort)

Replace the recursive per-object graph walk with batch SQL queries.
Options:

- Load all objects for a repo in a single query and walk in-memory.
  For the cannoli repo that's 43 MB — feasible for moderate repos.
- Use `WHERE hash IN (...)` batches: walk one level of the graph, batch
  the next level's hashes into a single query. Reduces round-trips from
  4 678 to ~10-20 batched queries.
- Add a `commit_graph` table (like git's commit-graph file) with parent
  links, enabling SQL-level reachability queries without reading object
  content.

Expected impact: enumeration drops from ~97 ms to ~20-30 ms.

### F. Thin packs (moderate impact, moderate effort)

When the client provides `have` hashes, use objects reachable from
those hashes as delta bases (without including them in the pack). The
pack is "thin" — it references objects the client already owns.

Requires:

- Building delta indices for have-side objects.
- Marking those bases as available-but-not-sent.
- Signaling `thin-pack` capability in the advertisement.

Expected impact: incremental fetches transfer significantly less data.
Most valuable for CI/CD workflows doing frequent fetches.

### G. Protocol v2 (low perf impact, high compatibility value)

Add a `POST /git-receive-pack` v2 handler alongside the v1 endpoints.
The `ls-refs` command lets clients filter refs by prefix. The `fetch`
command combines negotiation + pack transfer in a single stateless
request.

Effort is moderate — the pkt-line codec already handles the wire format,
and the object walk / pack generation code is reusable. Main work is
routing, capability advertisement, and the `ls-refs` command.

### H. SQLite object compression (low impact, low effort)

Store object content compressed (zlib) in the `git_objects` table.
Decompress on read. Reduces storage footprint by ~60-70 %. Marginal
read-time cost (~10-20 ms for a full walk).

Currently the cannoli repo uses 46.2 MB of object data. Compressed that
would be ~15-18 MB. For disk-backed SQLite this matters more than for
in-memory.

Trade-off: objects served via upload-pack need to be decompressed for
delta computation anyway, so this mostly helps storage, not serving.

---

## Implemented optimizations

### A. Pack cache — done

Added `PackCache` in `operations.ts`, keyed on `(repoPath, sorted wants)`
for full-clone requests (0 haves). Integrated into the handler via
`GitServerConfig.packCache`. Defaults to 256 MB limit.

**Impact (cannoli):** 5 parallel clones wall time dropped from ~8.5 s to
~2.1 s (cache hit serves the pack in <1 ms).

### B. Single-pass inflate — done

Replaced the binary-search `inflateWithSize` in `lib/pack/packfile.ts`
with `inflateSync(data, { info: true })` via the `inflateWithConsumed`
extension to the `ZlibProvider` in `lib/pack/zlib.ts`. One inflate call
per entry instead of ~13.

**Platform portability:** `{ info: true }` is supported on all server-side
runtimes (Bun, Node.js, Deno, Cloudflare Workers with `nodejs_compat`).
Feature-detected at startup; browser environments fall back to the
binary search.

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

### C + D. Streaming response + configurable deltas — done

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
| G. Protocol v2        | ★★     | Medium | Repos with 1000s of refs, or partial clone support    |
| H. Compressed storage | ★      | Low    | Disk-backed SQLite with large object stores           |

Protocol v1 remains fully supported by all Git clients and servers.
No deprecation timeline exists. v2 is a feature for scale and partial
clone, not a compatibility requirement.
