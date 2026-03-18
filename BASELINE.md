# Baseline Performance & Storage Modality Analysis

Recorded 2026-03-17 on macOS (darwin 24.6.0), Bun runtime.

## Performance baselines

All measurements use the oracle profiling infrastructure, which replays pre-generated traces against the virtual (in-memory VFS) implementation. These numbers represent the **VFS-backed `PackedObjectStore`** path — the primary storage modality for the client/agent use case.

### Throughput (bench.ts — virtual walk, no oracle comparison)

| Preset  | Steps | Seed | Wall time | Steps/s | Git ops/s | Avg/git-op |
| ------- | ----- | ---- | --------- | ------- | --------- | ---------- |
| core    | 500   | 1    | 939ms     | 532     | 480       | 2.08ms     |
| core    | 1500  | 42   | 3661ms    | 410     | 371       | 2.69ms     |
| kitchen | 500   | 1    | 985ms     | 508     | 458       | 2.18ms     |

Throughput degrades ~30% from 500 to 1500 steps as repos grow (more objects to walk, larger trees). This is the pattern Phase 1 aims to improve.

### Oracle profile: core-test (5 traces, ~350 steps each)

| Command         | Count | Total | Mean   | Median | P95    | Max    |
| --------------- | ----- | ----- | ------ | ------ | ------ | ------ |
| FILE_BATCH      | 183   | 302ms | 1.65ms | 1.33ms | 3.48ms | 22.3ms |
| git add         | 298   | 278ms | 0.93ms | 0.61ms | 2.64ms | 22.0ms |
| FILE_RESOLVE    | 29    | 243ms | 8.39ms | 7.22ms | 18.4ms | 19.9ms |
| git commit      | 179   | 241ms | 1.35ms | 1.03ms | 3.97ms | 6.03ms |
| git rebase      | 51    | 221ms | 4.33ms | 1.24ms | 20.9ms | 40.5ms |
| git cherry-pick | 63    | 125ms | 1.99ms | 1.71ms | 5.74ms | 8.02ms |

Wall time: 2.2s for 1738 steps (790 steps/s).

### Oracle profile: validate-core (15 traces, ~350 steps each)

| Command      | Count | Total | Mean   | Median | P95    | Max    |
| ------------ | ----- | ----- | ------ | ------ | ------ | ------ |
| FILE_BATCH   | 549   | 812ms | 1.48ms | 1.34ms | 3.00ms | 6.63ms |
| FILE_RESOLVE | 87    | 759ms | 8.73ms | 7.80ms | 20.2ms | 25.5ms |
| git add      | 894   | 700ms | 0.78ms | 0.51ms | 2.38ms | 5.93ms |
| git commit   | 537   | 681ms | 1.27ms | 0.96ms | 3.39ms | 7.24ms |
| git rebase   | 153   | 582ms | 3.81ms | 0.94ms | 20.9ms | 41.3ms |

Wall time: 5.6s for 5214 steps (931 steps/s).

### Oracle profile: core3, trace 1 (1665 steps, long single trace)

| Command      | Count | Total | Mean   | Median | P95    | Max    |
| ------------ | ----- | ----- | ------ | ------ | ------ | ------ |
| FILE_RESOLVE | 39    | 705ms | 18.1ms | 16.0ms | 29.6ms | 31.7ms |
| git add      | 426   | 529ms | 1.24ms | 0.60ms | 3.96ms | 7.87ms |
| git rebase   | 59    | 488ms | 8.27ms | 2.79ms | 44.1ms | 103ms  |
| git commit   | 193   | 481ms | 2.49ms | 2.27ms | 5.24ms | 6.71ms |

Wall time: 3.9s (427 steps/s). Slowest single command: `git rebase` at 103ms. Mean git op time increases from ~1.5ms at step 0–200 to ~3.3ms at step 1600+. This confirms that performance degrades as repos grow.

### Oracle profile: kitchen6 (10 traces, ~1200 steps each, includes gc/repack)

| Command      | Count | Total | Mean   | Median | P95    | Max    |
| ------------ | ----- | ----- | ------ | ------ | ------ | ------ |
| git gc       | 39    | 4.6s  | 117ms  | 49.0ms | 751ms  | 776ms  |
| FILE_RESOLVE | 129   | 1.6s  | 12.8ms | 12.3ms | 24.0ms | 29.0ms |
| git add      | 1501  | 1.3s  | 0.85ms | 0.55ms | 2.64ms | 7.91ms |
| git repack   | 24    | 990ms | 41.2ms | 30.0ms | 159ms  | 174ms  |
| git rebase   | 350   | 1.1s  | 3.14ms | 0.81ms | 14.3ms | 56.2ms |

Wall time: 17.1s for 12007 steps (702 steps/s). `gc` and `repack` dominate — they use `enumerateObjectsWithContent` + `writePackDeltified`, which is exactly the pipeline Phase 1 targets.

### Repo size growth (core3 trace 1, 1665 steps, no gc)

| Step | Files | WT Size | Index | Conflicts | Objects | Obj Store |
| ---- | ----- | ------- | ----- | --------- | ------- | --------- |
| 200  | 29    | 68.2KB  | 19    | 23        | 321     | 370.6KB   |
| 600  | 70    | 169.9KB | 70    | 0         | 1584    | 1.9MB     |
| 1000 | 52    | 97.7KB  | 47    | 0         | 2458    | 2.9MB     |
| 1400 | 81    | 218.1KB | 78    | 0         | 3704    | 4.4MB     |
| 1664 | 45    | 89.1KB  | 45    | 0         | 4670    | 5.6MB     |

Without gc, object store grows linearly. At 4670 objects / 5.6MB, operations like rebase (which does object walks) start to show 100ms+ times.

### Repo size growth (kitchen6 trace 1, 1174 steps, with gc)

| Step | Files | WT Size | Index | Conflicts | Objects | Obj Store |
| ---- | ----- | ------- | ----- | --------- | ------- | --------- |
| 200  | 4     | 6.7KB   | 2     | 0         | 96      | 70.9KB    |
| 600  | 16    | 35.1KB  | 10    | 10        | 277     | 263.6KB   |
| 1000 | 20    | 43.1KB  | 16    | 0         | 381     | 436.9KB   |
| 1174 | 79    | 168.1KB | 52    | 0         | 491     | 544.0KB   |

With gc, object count stays low (491 vs 4670) and object store is 10× smaller. gc itself is expensive (up to 776ms) because it does a full object walk + deltified pack write.

## Storage modality analysis

Phase 1 changes the core interfaces that all storage backends implement. Here's how each modality is affected.

### In-memory VFS (`PackedObjectStore` + `InMemoryFs`)

**Primary use case**: agents running git in a browser, Cloudflare Worker, or any environment without real disk.

**Current characteristics**: All objects live in the VFS as byte arrays in a `Map`. Pack files are `Uint8Array` values in the same map. `PackReader` holds references to these buffers.

**Phase 1 impact**:

- **Streaming enumeration (step 1)**: Pure win. Instead of accumulating all objects into an array, the iterator yields and releases them. Peak memory during fetch/clone serving drops significantly.
- **Streaming pack write (step 2)**: Pure win. The pack is built incrementally rather than constructing a full `PackInput[]` first.
- **Deltified transport (step 3)**: Win for transfer size. The delta computation (`findBestDeltas`) still needs the object list in memory temporarily, but the output pack is much smaller. For in-memory VFS, the stored pack on the receiving side is also smaller (deltified packs are denser).
- **Streaming pack ingestion (step 4)**: Moderate win. `readPack` currently materializes all entries. With streaming, entries are written to the VFS one at a time. The VFS still holds everything in memory, so the floor is the same — but peak during ingestion drops because we don't hold both the parsed entries array _and_ the VFS copies simultaneously.
- **Object cache (step 5)**: Win for repeated reads (tree walking, merge-base finding). Avoids redundant inflate calls. The cache consumes memory, but it's bounded (16MB default) and replaces memory that was being allocated transiently anyway (inflate allocations).
- **Lazy pack discovery (step 6)**: Moderate win. In VFS, "loading" a pack is just grabbing a reference to an existing `Uint8Array` — no real I/O. But deferring `PackReader` construction (which parses the index) saves CPU at init time. For repos with few packs (common after gc), the benefit is negligible.

**Risk**: Very low. All changes reduce peak memory or improve CPU usage. The VFS path has no I/O latency to worry about, so streaming vs batch is purely about memory allocation patterns.

### SQLite (`SqliteStorage`)

**Primary use case**: server-side persistence. Multiple repos in one database.

**Current characteristics**: Objects are rows in a table. Reads are SQL queries. Writes are INSERT statements. Pack ingestion uses `readPack` to materialize all entries, then inserts each one.

**Phase 1 impact**:

- **Streaming enumeration (step 1)**: Win. The object walk reads from SQLite (each `read()` is a SELECT). Yielding objects one at a time instead of accumulating means the walk's memory footprint is the visited-set + one object at a time, not visited-set + all objects.
- **Streaming pack write (step 2)**: Win. The server builds packs from the iterator without holding all object content.
- **Deltified transport (step 3)**: Win for transfer size, but requires holding objects during delta computation. `findBestDeltas` needs content for similarity comparison. For the server, this is the one place where all objects must be in memory simultaneously. Possible future optimization: delta computation that reads from the store as needed rather than pre-loading.
- **Streaming pack ingestion (step 4)**: Win. `SqliteStorage.ingestPack` currently calls `readPack` which materializes everything. With streaming, it can INSERT rows as entries are inflated from the pack stream. This is the biggest win for SQLite — a large push doesn't require holding all objects in memory before writing them.
- **Object cache (step 5)**: Win. SQLite reads involve crossing the FFI boundary (bun:sqlite). Caching avoids repeated roundtrips for frequently-accessed objects (trees during walks). The bounded cache is especially valuable here because SQLite reads are more expensive than VFS map lookups.
- **Lazy pack discovery (step 6)**: Not applicable — `SqliteStorage` doesn't use `PackedObjectStore` or pack files. No changes needed.

**Risk**: Low. The `ObjectStore` interface changes need to be mirrored in `SqliteStorage`, but the changes are additive (streaming variants) or purely internal (cache). The main risk is that `ingestPack` changes need careful testing — SQLite transactions should wrap batch inserts for performance.

### Real filesystem (`PackedObjectStore` + real `IFileSystem`)

**Possible use case**: server backed by disk instead of SQLite. Uses the same `PackedObjectStore` but with a real filesystem implementation instead of `InMemoryFs`.

**Phase 1 impact**: Same as in-memory VFS, except:

- **Lazy pack discovery (step 6)**: Bigger win than VFS. Real I/O to read pack files is expensive. Deferring pack loading until actually needed avoids reading multi-megabyte pack files at startup.
- **Object cache (step 5)**: Bigger win than VFS. Real disk reads (even with OS page cache) are slower than VFS map lookups. The cache avoids repeated `read` + `inflate` roundtrips.
- **Streaming pack ingestion (step 4)**: Bigger win. Real writes are slower, so not holding the full parsed entry list while writing reduces memory pressure during push handling.

**Risk**: Low. Same interface changes as VFS. Real I/O errors (disk full, permissions) are already handled by the filesystem implementation, not the object store.

### IndexedDB (future browser storage)

**Possible use case**: browser-based git with persistent storage across sessions. An `IndexedDB`-backed `ObjectStore` would be similar to `SqliteStorage` but in the browser.

**Phase 1 impact**: Same as SQLite — the `ObjectStore` interface changes apply uniformly. Streaming is especially important here because IndexedDB transactions are async and can be slow. Streaming pack ingestion would allow writing objects in batches within a single transaction rather than materializing everything first.

**Risk**: None currently (doesn't exist yet). The streaming `ObjectStore` interface designed in Phase 1 will be a better foundation for an IndexedDB implementation than the current batch-oriented interface.

### Summary

| Change               | In-memory VFS | SQLite | Real FS | IndexedDB |
| -------------------- | ------------- | ------ | ------- | --------- |
| Streaming enum       | ++            | ++     | ++      | ++        |
| Streaming pack write | ++            | ++     | ++      | ++        |
| Deltified transport  | ++            | ++     | ++      | ++        |
| Streaming ingestion  | +             | +++    | ++      | +++       |
| Object cache         | +             | ++     | +++     | ++        |
| Lazy pack discovery  | ~             | n/a    | +++     | n/a       |

`+++` = high impact, `++` = moderate, `+` = minor, `~` = negligible, `n/a` = not applicable.

No modality is negatively impacted by any Phase 1 change. The changes are universally beneficial, with the degree varying by storage backend. The biggest beneficiaries are SQLite and real-FS backends (more expensive I/O makes caching and streaming more valuable), but the VFS path also improves — primarily through reduced peak memory allocation.
