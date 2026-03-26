# Oracle-based testing framework

Compares `just-git` against real git by pre-generating **oracle traces** (recordings of real git's behavior) and replaying them against our virtual implementation.

## Quick start

```bash
# One-command validation (generates + tests core & kitchen presets)
bun oracle validate

# Or manually: generate, then test
bun oracle generate basic --seeds 1-20 --steps 300
bun oracle test basic

# Investigate a failure
bun oracle inspect basic 5 42
bun oracle rebuild basic 5 42
```

## CLI reference

All operations go through `cli.ts`. The first argument after the subcommand is always the **database name**. Databases are stored at `data/<name>/traces.sqlite`, keeping the sqlite file and its WAL/SHM sidecars contained in their own directory.

### `validate` — quick confidence check

Generates and tests a representative set of oracle traces in one step. Runs the `core` and `kitchen` presets with a small seed count. Warns if the local git version doesn't match 2.53.x.

```
bun oracle validate [options]
```

| Option            | Default | Description                         |
| ----------------- | ------- | ----------------------------------- |
| `--seeds <spec>`  | `1-5`   | Seed specification                  |
| `--steps <n>`     | 300     | Steps per seed                      |
| `-v`, `--verbose` | —       | Show per-step output during testing |

```bash
bun oracle validate                    # 5 seeds × 300 steps, core + kitchen
bun oracle validate --seeds 1-10       # more seeds for deeper coverage
bun oracle validate --seeds 1-3 -v     # fewer seeds, verbose output
```

### `generate` — create oracle traces

Runs the random walker against real git, capturing a full snapshot of repository state after each step.

```
bun oracle generate [name] --seeds <spec> [options]
```

| Option              | Default      | Description                                                         |
| ------------------- | ------------ | ------------------------------------------------------------------- |
| `--seeds <spec>`    | _(required)_ | `"1-20"` or `"1,2,42"`                                              |
| `--steps <n>`       | 300          | Walker steps per seed                                               |
| `--preset <name>`   | `default`    | Action set (see presets below)                                      |
| `--chaos <rate>`    | preset       | Probability (0-1) of bypassing soft preconditions; overrides preset |
| `--clone-url <url>` | —            | Clone from this URL instead of `git init` (requires network)        |
| `--description <s>` | auto         | Metadata tag for traces                                             |

If no name is given, defaults to the preset name.

**Presets:** `default`, `basic`, `core`, `rebase-heavy`, `merge-heavy`, `cherry-pick-heavy`, `no-rename-show`, `no-show`, `wide-files`, `chaos`, `chaos-heavy`, `clone-cannoli`, `clone-core`, `fuzz-light`, `fuzz-heavy`, `chaos-fuzz`, `gitignore`, `kitchen`, `stress`, `remote`, `remote-core`, `remote-heavy`

Each preset adjusts which random actions are enabled and their weight multipliers. The `-heavy` variants boost the weight of their respective operations. `core` focuses on ~60 daily-use actions with light chaos (5%) and fuzz (3%). `no-rename-show` excludes `mvFile` and `showHead` actions. `no-show` excludes only `showHead` (allows renames via `mvFile`). `chaos` / `chaos-heavy` set a `chaosRate` to bypass soft preconditions on a percentage of steps. `fuzz-*` presets inject wrong values (non-existent branches, files, commits) to exercise error handling. `clone-cannoli` / `clone-core` clone from a remote repo instead of `git init` (requires network). `kitchen` combines chaos, light fuzz, and gitignore generation. `stress` builds very large repos for performance profiling (best with `--steps 2000` or more). `remote` / `remote-core` / `remote-heavy` spin up a just-git HTTP server as a remote and exercise push/fetch/pull alongside normal operations (see [Remote presets](#remote-presets) below).

```bash
# Uses preset name as db name → data/rebase-heavy/traces.sqlite
bun oracle generate --preset rebase-heavy --seeds 1-20

# Explicit name → data/my-experiment/traces.sqlite
bun oracle generate my-experiment --preset merge-heavy --seeds 1-5
```

#### Remote presets

The `remote`, `remote-core`, and `remote-heavy` presets exercise push/fetch/pull by spinning up a just-git HTTP server during generation. Real git communicates with it over HTTP; during replay the same server runs in-process via `asNetwork`. Both sides see the same URL in commands, so output comparison works without normalization.

Each trace starts with `git init` + `git remote add origin <url>/repo` + an initial commit and push, so the remote has content from step 0.

| Preset         | Actions                         | Chaos | Fuzz  | Notes                                   |
| -------------- | ------------------------------- | ----- | ----- | --------------------------------------- |
| `remote`       | All actions (including network) | 5%    | —     | General remote coverage                 |
| `remote-core`  | Core + network actions          | 5%    | light | Daily-use commands with push/fetch/pull |
| `remote-heavy` | All actions, remote category 3x | 5%    | —     | Stress-tests transport layer            |

The server uses `MemoryStorage` with `autoCreate: true` and is reset between traces (each trace gets a fresh server). Within a trace, the server accumulates state from pushes, which subsequent fetches/pulls read back.

```bash
bun oracle generate remote-core --seeds 1-10 --steps 200
bun oracle test remote-core
```

### `test` — replay and compare

Replays oracle traces against the virtual implementation, comparing both state and output at every step.

**Checked at each step:**

- **State**: HEAD, refs, index, worktree hash, active operation, operation state, stash hashes
- **Output**: exit code, stdout, stderr (per-command skip lists in `checker.ts` bypass stdout/stderr for commands with known unimplemented output)

```
bun oracle test [name] [trace] [-v] [--stop-at N] [--seeds <spec>] [--no-post-mortem]
```

Without a trace number, runs **all** traces in the DB. Default output is one line per trace:

```
  PASS  trace 1   302 steps
  PASS  trace 2   302 steps
  FAIL  trace 3   step 31/302  git cherry-pick c1e1889...
        active_operation: expected="cherry-pick" actual=null
  PASS  trace 4   302 steps

3/4 passed, 1 failed
```

Failures show the first divergence field. State failures are reported before output mismatches so post-mortem classification can kick in. Add `-v` for per-step output. Exits with code 1 if any trace fails.

```bash
bun oracle test basic          # all traces
bun oracle test basic 5        # single trace
bun oracle test basic 5 -v     # verbose single trace
```

### `inspect` — examine a step

Replays the trace up to the given step, then shows oracle state, impl state, and any divergences side-by-side. Also shows context (preceding commands) and oracle stdout/stderr.

```
bun oracle inspect <name> <trace> <step>
```

Example output:

```
--- Trace 5, Step 42 ---

Context (preceding steps):
  [37] git checkout main
  [38] git commit -m "commit-xyz"
  ...

Command: git merge --no-ff branch-name
Exit code: 1

Oracle state:
  HEAD: ref: refs/heads/main -> abc123...
  Operation: merge (def456...)
  Refs: 4  Index: 6 + 2 conflict
  Worktree: 789abc...

Impl state:
  HEAD: ref: refs/heads/main -> abc123...
  Operation: merge (111222...)
  Refs: 4  Index: 6 + 2 conflict
  Worktree: 789abc...

Divergences (1):
  operation_state_hash:
    oracle: "def456..."
    impl:   "111222..."
```

### `trace-context` — show command history around a step

Prints the command sequence leading up to a step (with exit codes), useful for
quick context without full inspect output.

```
bun oracle trace-context <name> <trace> <step> [--before N]
```

```bash
bun oracle trace-context basic 5 42
bun oracle trace-context basic 5 42 --before 20
```

### `diff-worktree` — list differing files

Replays both oracle (real git) and impl (virtual git) to a step, then compares
full worktree files path-by-path.

```
bun oracle diff-worktree <name> <trace> <step> [--limit N]
```

Output includes each differing path with content length and SHA-1 for oracle vs
impl.

```bash
bun oracle diff-worktree basic 5 42
bun oracle diff-worktree basic 5 42 --limit 100
```

### `diff-file` — inspect one file mismatch

Shows the first line-level mismatch between oracle and impl for a specific
path.

```
bun oracle diff-file <name> <trace> <step> <path>
```

```bash
bun oracle diff-file cherry-pick 149 281 initial.txt
```

### `conflict-blobs` — inspect stage 1/2/3 blobs

For conflicted paths, prints stage entries from oracle and impl with blob ids,
modes, lengths, and content hashes; optional `--full` prints full content.

```
bun oracle conflict-blobs <name> <trace> <step> <path> [--full]
```

```bash
bun oracle conflict-blobs cherry-pick 149 281 initial.txt
bun oracle conflict-blobs cherry-pick 149 281 initial.txt --full
```

### `rebuild` — materialize a real git repo

Replays a trace up to a given step using real git, leaving a directory you can `cd` into and inspect.

```
bun oracle rebuild <name> <trace> <step>
```

```bash
bun oracle rebuild basic 5 42
# → Real git repo at: /tmp/replay-git-XXXXX
#   cd /tmp/replay-git-XXXXX && git log --oneline --all --graph
```

Clean up the temp directory when done.

### `profile` — command execution timing

Replays traces and measures per-command execution time.

```
bun oracle profile [name] [trace] [--csv] [--top N]
```

```bash
bun oracle profile basic          # all traces
bun oracle profile basic 5        # single trace
bun oracle profile basic --top 20 --csv
```

### `size` — repo size over time

Replays traces and measures repo size growth at regular intervals.

```
bun oracle size [name] [trace] [--every N] [--csv]
```

Shows worktree files/bytes, index entries, conflict entries, and object store stats.

```bash
bun oracle size basic 5 --every 100
bun oracle size basic --csv
```

### `planner-inspect` — rebase planner comparison

Compares the rebase planner output against real git `rev-list` at the state before a given step. The specified step should be a rebase command.

```
bun oracle planner-inspect <name> <trace> <step>
```

```bash
bun oracle planner-inspect rebase-heavy 5 42
```

### `summary` — aggregate test results

Scans all `test-results.log` files in `data/*/` and prints a summary of WARN, KNOWN, and FAIL counts by set and by pattern.

```
bun oracle summary
```

Example output:

```
══ Oracle Test Results — Aggregate Summary ══

Per-set overview:
  Set              WARN  KNOWN  FAIL  Total
  ───────────────  ────  ─────  ────  ─────
  clone-core          1      3     0      4
  core                0      1     0      1
  kitchen             0      5     0      5
  ...
  TOTAL               7     93     2    102

By type:
  FAIL: 2
  WARN: 7
  KNOWN: 93

By pattern:
  rename-detection-ambiguity  (53 total: 53 known)
    sets: kitchen5: 20, kitchen3: 11, ...
  ...

FAIL details:
  [kitchen3] trace 73  step 384/385  git repack
    stdout: expected="" actual="Nothing new to pack.\n"
```

### `clean` — remove leftover temp directories

Removes stale oracle temp directories (`oracle-git-*`, `oracle-home-*`, `replay-git-*`, `replay-home-*`) from the system temp directory.

```
bun oracle clean
```

## Debugging workflow

1. **Run the suite** — `test basic` to get a summary.
2. **Find the failing step** — note the trace ID and step number from the output.
3. **Inspect the step** — `inspect basic 5 42` to see oracle vs impl state side-by-side with the diff.
4. **Replay verbose** — `test basic 5 -v` to see every step leading up to the failure.
5. **Narrow to files** — `diff-worktree basic 5 42`, then `diff-file basic 5 42 <path>`.
6. **Inspect conflict stages** (if needed) — `conflict-blobs basic 5 42 <path>`.
7. **Rebuild the repo** — `rebuild basic 5 42` to get a real git repo at that point. Inspect it with standard git commands.

## Post-mortem analysis

When a trace fails, the test runner invokes `post-mortem.ts` to classify the divergence as either a **known acceptable difference** or a genuine bug. Known patterns are reported as `KNOWN` instead of `FAIL`, allowing the suite to distinguish real regressions from expected implementation differences.

**Known divergence patterns (post-mortem):**

| Pattern                           | Type                      | Description                                                                                                                   |
| --------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `rename-detection-ambiguity`      | Hybrid                    | Can be output-only or stateful depending on branch (stateful branches include index/worktree divergence from rename pairing). |
| `rebase-planner-match`            | Output-only (current use) | Planner commits match, but output formatting/diagnostics differ.                                                              |
| `rebase-planner-subset`           | Stateful                  | Our planner is a strict subset of git's — fewer commits replayed due to git's timestamp-walk quirk (see below).               |
| `merge-conflict-marker-alignment` | Worktree-only             | Conflict marker boundary differs — index matches, only worktree hash diverges (see below).                                    |

### Rebase planner subset — why our planner produces fewer commits

Our `collectRebaseSymmetricPlan` computes the exact set difference via full BFS from both tips: `R(HEAD) - R(upstream)`. Git's `rev-list upstream...HEAD` uses a timestamp-ordered walk that propagates UNINTERESTING marks lazily through parent links.

When commit timestamps are non-monotonic (common after amends and rebases create commits with earlier timestamps than their topological successors), git's walker can include **false positives**: an INTERESTING path reaches a commit before the UNINTERESTING path does, so git outputs the commit even though it IS reachable from the excluded ref. Our BFS computes the exact reachable sets and produces the mathematically correct (smaller) result.

This has been verified empirically: computing `R(HEAD)` and `R(upstream)` independently and taking the set difference produces fewer commits than `git rev-list HEAD --not upstream`, and the "extra" commits in git's output are confirmed present in `git rev-list upstream`.

This is **not fixable** without deliberately replicating git's timestamp-walk quirk, which would make our planner less correct. It is also **not worth fixing** — our behavior produces cleaner rebases that skip upstream-reachable commits.

**How it manifests:** The rebase replays fewer commits, leading to a different resulting index, worktree, and operation state. The planner-inspect tool confirms our commits are always a strict subset (no spurious extras).

### Rename detection ambiguity — why it exists and why it's not fixable

When merge-ort detects renames (Phase 2 of the three-way merge), it pairs deleted files with added files based on content similarity. When multiple deleted files share the same blob hash, the pairing is ambiguous — any of them could be matched to the added file. Real git's tiebreaking depends on hashmap iteration order (the order entries happen to land in `diffcore_rename`'s internal hash table), which is non-deterministic from the algorithm's perspective. Our implementation uses sorted arrays and basename-first matching, which is equally valid but produces different pairings in some edge cases.

This is **not fixable** without replicating git's exact hashmap implementation (bucket count, probe sequence, insertion order), which is internal and unspecified. The rename detection scores are identical — it's purely about which equally-scored candidate gets picked first.

**How it manifests (from most to least common):**

1. **merge --squash with state divergence** — Different rename pairings produce different merge-ort results (different conflict stages, different auto-resolutions). The index ends up with different entries. Most common trigger: `git mv` followed by `git merge --squash` where the merge target also modifies/deletes the renamed file.

2. **merge --squash output-only** — Merge succeeds on both sides with identical state, but stdout/stderr differs (different diffstat, different "Auto-merging" / "CONFLICT" messages) because merge-ort traversed the rename graph differently.

3. **cherry-pick / rebase execution** — A cherry-pick during rebase (or standalone) goes through merge-ort. Different rename pairing → different conflict stages or auto-resolutions. The rebase planner may match perfectly, but individual pick steps diverge.

4. **Cascading to unrelated commands** — Once a merge/cherry-pick/rebase produces a different index state, every subsequent command operates on diverged state. This surfaces as divergences on `switch --orphan`, `checkout`, `restore`, `reflog`, etc. — commands that have nothing to do with rename detection themselves. The post-mortem's generic fallback catches these by detecting index stage mismatches.

**The `no-rename-show` preset** avoids this entirely by excluding `mvFile` actions (no renames in the trace → no rename detection ambiguity). Use it when you want to test non-rename behavior without noise.

### Merge conflict marker alignment — why worktree hashes can differ with matching indexes

When a three-way merge produces conflicts, the worktree file is written with conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). The exact placement of marker boundaries — specifically, how many trailing common lines are included inside vs. outside a conflict region — depends on the conflict simplification algorithm.

Git's `merge-ort` uses `ll_merge` → `xdl_merge` with `XDL_MERGE_ZEALOUS` simplification, while our diff3 implementation produces output matching `git merge-file` (which uses `XDL_MERGE_ZEALOUS_ALNUM`). Both produce correct, resolvable conflict markers, but they can disagree on boundary placement when:

- The merged file already contains conflict markers from a prior unresolved operation
- Repeated content near conflict boundaries creates ambiguous grouping decisions
- Trailing common lines sit at the boundary between a conflict and the next region

This is **not fixable** without replicating git's exact `xdl_refine_conflicts` and `xdl_simplify_non_conflicts` internals, which depend on line-level classification heuristics (`xdl_hash_classifier_helpers`) that differ between zealous levels. The difference is purely cosmetic — both renderings resolve identically.

**How it manifests:** The index matches perfectly (same conflict stages, same blob SHAs), but the worktree hash differs because the conflict-marked file has slightly different marker boundaries. Typically one extra or fewer conflict end marker (`>>>>>>>`) in one rendering vs. the other.

**Output-only patterns handled by `checker.ts`** (tolerated, don't block traces):

| Pattern                              | Description                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined diff formatting             | `git show` merge commit headers match, `diff --cc` sections differ.                                                                             |
| Diff hunk alignment                  | `git diff` same files/headers, different hunk boundaries (tie-breaking).                                                                        |
| Commit stat drift                    | `git commit`/`cherry-pick`/`revert`/`merge`/`rebase` same commit, different diffstat counts.                                                    |
| Rebase status todo drift             | `git status` during rebase differs only in todo lines/hashes; normalized before compare.                                                        |
| Merge-family diagnostic drift        | `git merge`/`cherry-pick`/`stash apply`/`pop` diagnostics differ in ordering/detail but have same normalized conflict/result shape.             |
| Rebase continuation diagnostic drift | `git rebase --continue`/`--skip` conflict diagnostics differ in detail/order but map to the same outcome bucket.                                |
| Rename collision output drift        | Merge/rebase rename-collision lines only.                                                                                                       |
| Clean directory-only output drift    | `git clean` file lines match; only directory lines differ (often empty-dir noise).                                                              |
| Checkout orphan count                | `git checkout`/`git switch` both warn about orphaned commits, count differs.                                                                    |
| Branch rebase/detached description   | `git branch` detached HEAD description differs after gc.                                                                                        |
| Reflog reset entry drift             | `git reflog` differs only by cherry-pick `--skip` "reset: moving to" entries affected by gc reflog expiry.                                      |
| Log range timestamp walk             | `git log` with `..` range: non-monotonic timestamps cause git's walker to terminate early; our impl does full reachability walk (more correct). |
| Shell syntax error format            | Shell error format differs between real and virtual shell.                                                                                      |
| Worktree path stderr                 | Stderr messages embed different worktree paths (real temp dir vs virtual FS root).                                                              |
| Rebase progress stderr               | `git rebase` progress denominator differs.                                                                                                      |
| Network ref-line alignment           | `git push`/`fetch`/`pull` ref-update lines match after normalizing column padding and filtering progress lines.                                 |
| Network ref-line structure           | `git push`/`fetch`/`pull` ref-line structure matches (From/To + ref updates); hint/error trailer lines may differ.                              |
| Clone stderr path                    | `git clone` "Cloning into" path differs (absolute vs relative); progress output filtered.                                                       |
| Pull merge output                    | `git pull` merge-phase stdout handled via merge-family matchers (diffstat, diagnostics, rename collisions).                                     |

Matcher policy: never bypass state divergence; only normalize equivalent output.

## Architecture

### Seed-based file operation batches

File operations (create, edit, delete files) are stored as **seeds** rather than full content. A single `FILE_BATCH:<seed>` command in the trace replaces what used to be multiple `FILE_WRITE` commands with embedded content. At replay time, the same deterministic generation function regenerates the identical operations from the seed and the current worktree file list.

This works because:

- The generation function (`generateAndApplyFileOps` in `test/random/file-gen.ts`) is pure given `(seed, fileList)`.
- The file list is deterministic — if the virtual implementation matches real git (which is what we're testing), the file list will be the same.
- State is verified at every git-command step, so divergences are caught before the next file-op batch runs.

The result is dramatically smaller trace databases and the ability to test with larger repos without storage cost.

Conflict resolution uses `FILE_RESOLVE:<seed>` batches, which deterministically resolve all conflicted files from the seed and current worktree state. **Individual `FILE_WRITE`/`FILE_DELETE` commands** are a legacy format retained for backward compatibility.

### Trace generation pipeline

```
Random walker (test/random/)
  → RealGitHarness (real git in tmp dir)
      ↳ [remote presets] HTTP server (just-git, MemoryStorage, random port)
  → RecordingHarness (intercepts calls, serializes to command strings)
  → OracleStore (writes to SQLite)
```

Each trace is a sequence of **steps**. A step is either:

- A **git command** (`git commit -m "msg"`, `git checkout -b feature`, `git push origin main`, etc.)
- A **file op batch** (`FILE_BATCH:<seed>`) — regenerated deterministically at replay time
- A **conflict resolution batch** (`FILE_RESOLVE:<seed>`) — regenerated deterministically, resolves all conflicted files
- An **individual file op** (`FILE_WRITE:{...}`, `FILE_DELETE:{...}`) — legacy format for individual writes

After each step, a **snapshot** of the real git repo is captured and stored.

### Replay pipeline

```
OracleStore (reads steps from SQLite)
  → BatchChecker (loads snapshots into memory, reads TraceConfig)
  → Bash + virtual git (executes each command)
      ↳ [remote traces] in-process server via asNetwork(remoteBaseUrl)
  → captureImplState (reads virtual FS state)
  → compare() (diffs oracle vs impl)
```

For `FILE_BATCH` steps, replay lists the virtual worktree files and calls the shared generation function to regenerate and apply the same operations.

### What gets compared

At every step, both **state** and **output** are checked:

**State fields:**

| Field                  | Description                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `head_ref`             | Symbolic ref or detached (`ref: refs/heads/main` vs `null`)                           |
| `head_sha`             | Resolved HEAD commit hash                                                             |
| `refs`                 | All refs under `refs/` (includes `refs/stash`, `refs/remotes/*` tracking refs)        |
| `index`                | All index entries keyed by `path:stage` (mode + sha)                                  |
| `work_tree`            | SHA-1 hash of worktree contents (sorted path+content)                                 |
| `active_operation`     | `merge`, `cherry-pick`, `rebase`, or `null`                                           |
| `operation_state_hash` | Hash of operation-related files (MERGE_HEAD, MERGE_MSG, MERGE_MODE, rebase dir, etc.) |
| `stash_hashes`         | Ordered list of stash commit hashes (newest first), compared element-by-element       |

**Output fields:**

| Field       | Description                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exit_code` | Process exit code                                                                                                                                                |
| `stdout`    | Standard output (`git merge` exit≥2 skipped unconditionally; conditional matchers handle cosmetic differences in init paths, diff hunks, status, diagnostics)    |
| `stderr`    | Standard error (`git repack` and `git gc` skipped unconditionally; conditional matchers handle merge-precondition file lists, worktree paths, progress counters) |

### Deterministic timestamps

Both generation and replay use an incrementing counter for `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` (starting at Unix epoch 1000000000). This ensures commit hashes are identical across runs for the same sequence of operations. The counter increments for all commit-creating commands: `commit`, `merge`, `cherry-pick`, `pull`, and `rebase --continue`.

### Placeholder snapshots

When a random walker action produces multiple commands (e.g., resolve conflicts then `git add` then `git commit`), only the **last** command in the group gets a full snapshot. Earlier commands get a placeholder (empty `workTreeHash`). The replay engine detects these and skips comparison.

### Temp directory cleanup

Generation creates real git repos in temp directories. These are cleaned up via `try/finally` in the generation loop. Signal handlers (`SIGINT`, `SIGTERM`) ensure cleanup also runs if the process is killed during generation. The `replayTo` function (used by `rebuild`, `inspect`, etc.) also cleans up on error — only on success does it return the repo dir to the caller.

### Remote server architecture

Remote presets (`remote`, `remote-core`, `remote-heavy`) test push/fetch/pull by giving each trace its own just-git HTTP server as the "origin" remote.

**Generation:** `RealGitHarness.create({ withRemote: true })` starts a `createServer({ storage: new MemoryStorage(), autoCreate: true })` and serves it via `Bun.serve` on a random port. Real git communicates over HTTP at `http://localhost:<port>`. The `remoteBaseUrl` is stored in `TraceConfig` so replay knows the URL scheme. The server is stopped in `cleanup()`.

**Replay:** When `TraceConfig.remoteBaseUrl` is set, `createReplayEnvironment` creates a fresh in-process server with `MemoryStorage` and configures `createGit` with `server.asNetwork(remoteBaseUrl)`. This routes all HTTP transport calls to the server without any real network I/O, while keeping the same URLs that were recorded in the trace.

**Initial setup:** For remote traces (when `remoteBaseUrl` is set and `cloneUrl` is not), `runRecordedWalk` performs four setup commands before the random walk begins: `git remote add origin <url>/repo`, add a seed file, commit, and `git push -u origin main`. These are recorded as regular trace steps so replay executes them identically.

**QueryState:** The `remotes` field (populated via `listRemotes()` on the harness) lets network actions check whether a remote is configured before attempting push/fetch/pull.

## File reference

| File                 | Purpose                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`             | Unified CLI entry point                                                                                                         |
| `generate.ts`        | Trace generation engine, presets, `RecordingHarness`                                                                            |
| `impl-harness.ts`    | Replay engine, virtual state capture. Wires in-process server via `asNetwork` for remote traces                                 |
| `runner.ts`          | `replayTo()` — rebuild a real git repo at any step                                                                              |
| `capture.ts`         | Snapshot capture from real git repos                                                                                            |
| `checker.ts`         | `BatchChecker` — loads oracle data, checks state + output per step. Per-command skip lists and conditional matchers             |
| `compare.ts`         | State comparison: `compare()`, `matches()`, divergence types                                                                    |
| `post-mortem.ts`     | Classifies divergences as known patterns vs genuine bugs. Planner comparisons for rebase, rename analysis for merge/cherry-pick |
| `fileops.ts`         | File operation serialization (`FILE_BATCH`, `FILE_RESOLVE`, `FILE_WRITE`, `FILE_DELETE`)                                        |
| `real-harness.ts`    | `RealGitHarness` — `WalkHarness` backed by real git. Starts just-git HTTP server for remote presets                             |
| `store.ts`           | `OracleStore` — SQLite read/write for traces and steps                                                                          |
| `schema.ts`          | Database schema initialization                                                                                                  |
| `snapshot-delta.ts`  | Delta-compressed snapshots: `diffSnapshot()`, `applyDelta()`, `SnapshotDelta`                                                   |
| `planner-inspect.ts` | Standalone rebase planner comparison against real git `rev-list`                                                                |
| `data/<name>/`       | Generated databases, one directory per DB name (gitignored)                                                                     |

### Shared modules (`test/random/`)

| File          | Purpose                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `actions/`    | Action definitions split by category (`index.ts` re-exports `ALL_ACTIONS`, per-category arrays). `network.ts` covers push/fetch/pull |
| `file-gen.ts` | Shared batch generation: `generateAndApplyFileOps()`, `FileGenConfig`, gitignore support                                             |
| `harness.ts`  | `WalkHarness` interface, `VirtualHarness`                                                                                            |
| `types.ts`    | `Action` interface (with `category` and `fuzz`), `ActionCategory`, `FuzzConfig`                                                      |
| `pickers.ts`  | Value-selection helpers (`pickOtherBranch`, `pickFile`, etc.) with optional fuzz injection                                           |
| `walker.ts`   | Walk engine: `runWalk()`, `queryState()`, `pickAction()`                                                                             |
| `rng.ts`      | `SeededRNG` — deterministic xorshift128+ PRNG                                                                                        |
| `stats.ts`    | CLI: gather VFS statistics after a walk                                                                                              |
| `bench.ts`    | CLI: benchmark virtual-only walk throughput                                                                                          |

## Database schema

```sql
traces (
  trace_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  seed        INTEGER NOT NULL,
  description TEXT,
  config      TEXT,                   -- JSON TraceConfig (chaosRate, fileGen, fuzz, cloneUrl, remoteBaseUrl)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)

steps (
  step_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id  INTEGER NOT NULL REFERENCES traces(trace_id),
  seq       INTEGER NOT NULL,        -- 0-based position in trace
  command   TEXT NOT NULL,            -- git command, FILE_BATCH/FILE_RESOLVE:<seed>, or FILE_WRITE/DELETE
  exit_code INTEGER NOT NULL,
  stdout    TEXT,
  stderr    TEXT,
  snapshot  TEXT NOT NULL,            -- JSON SnapshotDelta (delta-compressed)
  UNIQUE(trace_id, seq)
)

CREATE INDEX idx_steps_trace ON steps(trace_id, seq);
```
