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

| Phase | Time | % |
|---|---|---|
| Object enumeration | ~97 ms | 6 % |
| Delta computation | ~1 400 ms | **85 %** |
| Pack writing (deflate) | ~112 ms | 7 % |
| Protocol + HTTP | ~30 ms | 2 % |
| **Total** | **~1 650 ms** | |

Output pack: 2 610 KB (from 43 MB raw), 2 660 deltas out of 4 378 objects.

5 parallel clones: each independently takes ~1 650 ms (wall ~8.5 s).
Every clone recomputes deltas from scratch — identical work repeated 5×.

### Receive-pack (push)

| Operation | Time |
|---|---|
| Initial push (4 336 objects, 1 653 KB pack) | 502 ms |
| → readPack (parse + inflate) | 398 ms |
| → SQLite batch insert | 35 ms |
| Incremental push (150 objects, 14 KB) | 8 ms |
| Tag-only push (56 refs, 47 objects) | 5 ms |

### End-to-end summary

| Operation | Time |
|---|---|
| git clone (from GitHub) | 545 ms |
| git push (initial, single branch) | 502 ms |
| git push --all (all branches) | 25 ms |
| git push --tags | 52 ms |
| git clone (from server) | 2 130 ms |
| 5 parallel clones (wall) | 8 460 ms |
| push 50 incremental commits | 60 ms |
| clone second repo (60 objects) | 80 ms |
| git fetch --all (catch up) | 39 ms |

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

### 2. No response streaming

`handleUploadPack()` returns a `Uint8Array` — the entire pack is
materialized in memory before a single byte is sent. The handler wraps
it in sideband pkt-lines and returns a fully-buffered `Response`.

The client sees zero bytes until all ~1 650 ms of server-side processing
finishes. Real git servers stream pack data progressively via
sideband-64k, allowing the client to start receiving objects while the
server is still compressing later entries.

Memory impact: all object contents (~43 MB) + deltas + compressed pack
(~2.6 MB) + sideband-wrapped response all live in memory simultaneously.

### 3. Object walk — per-object SQLite queries

`enumerateObjectsWithContent()` traverses the commit graph recursively.
Each `readObject()` and `objectExists()` call is a separate SQLite
`SELECT`. For 4 678 objects that's 4 678+ individual queries during the
want walk, plus more for the have-side.

At ~97 ms total (~20 µs per query) this is tolerable thanks to SQLite's
speed, but it would scale poorly for repos with 100k+ objects.

The `ObjectCache` helps for commits/trees on re-reads, but every object
is read at least once, and blobs are never cached.

### 4. `inflateWithSize` binary search in pack reader

`readPack()` in `lib/pack/packfile.ts` needs to know how many
compressed bytes each entry consumed. Since `inflate()` doesn't report
bytes consumed, it binary-searches by repeatedly inflating truncated
slices:

```
inflate(full remaining buffer)
binary search [2 .. remaining.length]:
    inflate(slice[0..mid])  →  correct size?  →  narrow
```

For the initial push of 4 336 objects, this means O(N × log(compressed))
inflate calls — explaining the 398 ms `readPack` time.

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

### C. Streaming response (high impact, moderate effort)

Return a `ReadableStream` from the handler instead of `Uint8Array`.
Stream the NAK/ACK preamble, then emit sideband pkt-line chunks as
objects are compressed.

The pack header (object count) is known after enumeration, so the
stream can start with the header and emit entries progressively.
Progress messages can be sent on sideband band-2 during delta
computation.

Expected impact:
- Time-to-first-byte drops from ~1 650 ms to ~100 ms.
- Peak memory drops from ~50 MB to ~1-2 MB (one object at a time).
- Total throughput unchanged, but perceived latency improves
  dramatically.

Requires changing the return type of `handleUploadPack()` and the
handler's `Response` construction. The commented-out streaming pack
writers in `packfile.ts` (lines 445-505) are a starting point.

### D. Configurable delta compression (moderate impact, low effort)

Add a server config option to control delta behavior:

```ts
interface GitServerConfig {
  // ...
  packOptions?: {
    /** Skip delta compression entirely. Larger packs, much faster. */
    noDelta?: boolean;
    /** Delta window size (default 10). Smaller = faster, worse ratio. */
    deltaWindow?: number;
    /** Max objects before disabling deltas automatically. */
    deltaThreshold?: number;
  };
}
```

With `noDelta: true`, the cannoli clone would produce a ~5 MB pack
(vs 2.6 MB) but in ~200 ms instead of ~1 650 ms. For localhost or LAN
serving, the bandwidth trade-off is almost always worth it.

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

## Priority matrix

| Fix | Impact | Effort | Notes |
|---|---|---|---|
| A. Pack cache | ★★★★★ | Medium | Eliminates redundant work |
| B. Fix inflateWithSize | ★★★★ | Low | Single-pass inflate |
| C. Streaming response | ★★★★ | Medium | TTFB + memory |
| D. Configurable deltas | ★★★ | Low | Quick win for LAN use |
| E. Batch object reads | ★★★ | Medium | Scales to large repos |
| F. Thin packs | ★★★ | Medium | Incremental fetch size |
| G. Protocol v2 | ★★ | Medium | Compatibility |
| H. Compressed storage | ★ | Low | Storage only |
