# Oracle-based testing framework

Compares `just-git` against real git by pre-generating **oracle traces** (recordings of real git's behavior) and replaying them against our virtual implementation.

## Quick start

```bash
# 1. Generate traces (runs real git, stores results in SQLite)
bun oracle generate basic --seeds 1-20 --steps 300

# 2. Run all traces against our implementation
bun oracle test basic

# 3. Investigate a failure
bun oracle inspect basic 5 42
bun oracle rebuild basic 5 42
```

## CLI reference

All operations go through `cli.ts`. The first argument after the subcommand is always the **database name**. Databases are stored at `data/<name>/traces.sqlite`, keeping the sqlite file and its WAL/SHM sidecars contained in their own directory.

### `generate` — create oracle traces

Runs the random walker against real git, capturing a full snapshot of repository state after each step.

```
bun oracle generate [name] --seeds <spec> [options]
```

| Option              | Default      | Description                    |
| ------------------- | ------------ | ------------------------------ |
| `--seeds <spec>`    | _(required)_ | `"1-20"` or `"1,2,42"`         |
| `--steps <n>`       | 300          | Walker steps per seed          |
| `--preset <name>`   | `default`    | Action set (see presets below) |
| `--description <s>` | auto         | Metadata tag for traces        |

If no name is given, defaults to the preset name.

**Presets:** `default`, `basic`, `rebase-heavy`, `merge-heavy`, `cherry-pick-heavy`, `no-rename-show`, `no-show`, `wide-files`, `chaos`, `chaos-heavy`

Each preset adjusts which random actions are enabled and their weight multipliers. `basic` excludes rebase. The `-heavy` variants boost the weight of their respective operations. `no-rename-show` excludes `mvFile` and `showHead` actions. `no-show` excludes only `showHead` (allows renames via `mvFile`). `chaos` / `chaos-heavy` set a `chaosRate` to bypass soft preconditions on a percentage of steps.

```bash
# Uses preset name as db name → data/rebase-heavy/traces.sqlite
bun oracle generate --preset rebase-heavy --seeds 1-20

# Explicit name → data/my-experiment/traces.sqlite
bun oracle generate my-experiment --preset merge-heavy --seeds 1-5
```

### `test` — replay and compare

Replays oracle traces against the virtual implementation, comparing both state and output at every step.

**Checked at each step:**

- **State**: HEAD, refs, index, worktree hash, active operation, operation state, stash hashes
- **Output**: exit code, stdout, stderr (per-command skip lists in `checker.ts` bypass stdout/stderr for commands with known unimplemented output)

```
bun oracle test [name] [trace] [-v] [--stop-at N]
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

**Known divergence patterns (post-mortem; mostly stateful):**

| Pattern                           | Type                      | Description                                                                                                                   |
| --------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `rename-detection-ambiguity`      | Hybrid                    | Can be output-only or stateful depending on branch (stateful branches include index/worktree divergence from rename pairing). |
| `merge-precondition-rename-paths` | Output-only               | Merge rejected with different path list in overwrite-precondition stderr framing.                                             |
| `merge-directory-rename`          | Stateful                  | Git detects whole-directory renames (e.g., `src/util/` → `lib/`); not implemented.                                            |
| `merge-recursive-base-rename2to1` | Stateful                  | Stage-1 hash mismatch from rename/rename(2to1) in virtual merge-base computation.                                             |
| `abort-untracked-conflict`        | Stateful                  | `merge --abort` / `rebase --abort` succeeds in impl but fails in Git due to untracked overwrite checks.                       |
| `rebase-planner-match`            | Output-only (current use) | Planner commits match, but output formatting/diagnostics differ.                                                              |
| `rebase-planner-extra-in-oracle`  | Stateful                  | Git includes commits already reachable from upstream.                                                                         |
| `rebase-planner-extra-in-ours`    | Stateful                  | Impl planner includes commits Git does not.                                                                                   |
| `rebase-planner-different`        | Stateful                  | Planner commit sets diverge in both directions.                                                                               |
| `rebase-todo-diverged`            | Hybrid                    | Can be output-only (status text) or stateful (actual todo/state divergence).                                                  |
| `diff3-ambiguity`                 | Stateful                  | Conflict-marker/worktree-level differences from different LCS alignment choices.                                              |

**Output-only patterns handled by `checker.ts`** (tolerated, don't block traces):

| Pattern                              | Description                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Combined diff formatting             | `git show` merge commit headers match, `diff --cc` sections differ.                      |
| Diff hunk alignment                  | `git diff` same files/headers, different hunk boundaries (tie-breaking).                 |
| Rebase status todo drift             | `git status` during rebase differs only in todo lines/hashes; normalized before compare. |
| Merge-family diagnostic drift        | `git merge`/`cherry-pick`/`stash apply                                                   | pop` diagnostics differ in ordering/detail but have same normalized conflict/result shape. |
| Rebase continuation diagnostic drift | `git rebase --continue                                                                   | --skip` conflict diagnostics differ in detail/order but map to the same outcome bucket.    |
| Clean directory-only output drift    | `git clean` file lines match; only directory lines differ (often empty-dir noise).       |
| Checkout orphan count                | `git checkout` both warn about orphaned commits, count differs.                          |

Matcher policy: never bypass state divergence; only normalize equivalent output.

## Architecture

### Seed-based file operation batches

File operations (create, edit, delete files) are stored as **seeds** rather than full content. A single `FILE_BATCH:<seed>` command in the trace replaces what used to be multiple `FILE_WRITE` commands with embedded content. At replay time, the same deterministic generation function regenerates the identical operations from the seed and the current worktree file list.

This works because:

- The generation function (`generateAndApplyFileOps` in `test/random/file-gen.ts`) is pure given `(seed, fileList)`.
- The file list is deterministic — if the virtual implementation matches real git (which is what we're testing), the file list will be the same.
- State is verified at every git-command step, so divergences are caught before the next file-op batch runs.

The result is dramatically smaller trace databases and the ability to test with larger repos without storage cost.

**Individual `FILE_WRITE`/`FILE_DELETE` commands** are still used for conflict resolution writes (`resolveAndCommit`, `rebaseContinue` actions) where files are written as part of a compound action interleaved with git commands.

### Trace generation pipeline

```
Random walker (test/random/)
  → RealGitHarness (real git in tmp dir)
  → RecordingHarness (intercepts calls, serializes to command strings)
  → OracleStore (writes to SQLite)
```

Each trace is a sequence of **steps**. A step is either:

- A **git command** (`git commit -m "msg"`, `git checkout -b feature`, etc.)
- A **file op batch** (`FILE_BATCH:<seed>`) — regenerated deterministically at replay time
- An **individual file op** (`FILE_WRITE:{...}`, `FILE_DELETE:{...}`) — for conflict resolution writes

After each step, a **snapshot** of the real git repo is captured and stored.

### Replay pipeline

```
OracleStore (reads steps from SQLite)
  → BatchChecker (loads snapshots into memory)
  → Bash + virtual git (executes each command)
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
| `refs`                 | All refs under `refs/` (includes `refs/stash`)                                        |
| `index`                | All index entries keyed by `path:stage` (mode + sha)                                  |
| `work_tree`            | SHA-1 hash of worktree contents (sorted path+content)                                 |
| `active_operation`     | `merge`, `cherry-pick`, `rebase`, or `null`                                           |
| `operation_state_hash` | Hash of operation-related files (MERGE_HEAD, MERGE_MSG, MERGE_MODE, rebase dir, etc.) |
| `stash_hashes`         | Ordered list of stash commit hashes (newest first), compared element-by-element       |

**Output fields:**

| Field       | Description                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exit_code` | Process exit code                                                                                                                                                                                            |
| `stdout`    | Standard output (per-command skip lists in `checker.ts`; conditional skips for `git init` path, `git reset --mixed` stat-cache, `git merge` exit≥2 strategy failure, `git diff` combined-diff)               |
| `stderr`    | Standard error (skipped for `git rebase`; merge-precondition file list mismatches tolerated via `mergeOverwriteStderrMatches()` when both sides have "would be overwritten by merge" with identical framing) |

### Deterministic timestamps

Both generation and replay use an incrementing counter for `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` (starting at Unix epoch 1000000000). This ensures commit hashes are identical across runs for the same sequence of operations. The counter increments for all commit-creating commands: `commit`, `merge`, `cherry-pick`, and `rebase --continue`.

### Placeholder snapshots

When a random walker action produces multiple commands (e.g., resolve conflicts then `git add` then `git commit`), only the **last** command in the group gets a full snapshot. Earlier commands get a placeholder (empty `workTreeHash`). The replay engine detects these and skips comparison.

### Temp directory cleanup

Generation creates real git repos in temp directories. These are cleaned up via `try/finally` in the generation loop. Signal handlers (`SIGINT`, `SIGTERM`) ensure cleanup also runs if the process is killed during generation. The `replayTo` function (used by `rebuild`, `inspect`, etc.) also cleans up on error — only on success does it return the repo dir to the caller.

## File reference

| File              | Purpose                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`          | Unified CLI entry point                                                                                                                                                          |
| `generate.ts`     | Trace generation engine, presets, `RecordingHarness`                                                                                                                             |
| `impl-harness.ts` | Replay engine, virtual state capture, `replayAndCheck()`                                                                                                                         |
| `runner.ts`       | `replayTo()` — rebuild a real git repo at any step                                                                                                                               |
| `capture.ts`      | Snapshot capture from real git repos                                                                                                                                             |
| `checker.ts`      | `BatchChecker` — loads oracle data, checks state + output per step. Contains per-command stdout/stderr skip lists and conditional matchers (e.g., `mergeOverwriteStderrMatches`) |
| `compare.ts`      | State comparison: `compare()`, `matches()`, divergence types                                                                                                                     |
| `post-mortem.ts`  | Classifies divergences as known patterns vs genuine bugs. Runs planner comparisons for rebase, rename detection analysis for merge/cherry-pick                                   |
| `fileops.ts`      | File operation serialization (`FILE_BATCH`, `FILE_WRITE`, `FILE_DELETE`)                                                                                                         |
| `real-harness.ts` | `RealGitHarness` — `WalkHarness` backed by real git                                                                                                                              |
| `store.ts`        | `OracleStore` — SQLite read/write for traces and steps                                                                                                                           |
| `schema.ts`       | Database schema initialization                                                                                                                                                   |
| `index.ts`        | Barrel exports                                                                                                                                                                   |
| `data/<name>/`    | Generated databases, one directory per DB name (gitignored)                                                                                                                      |

### Shared modules (`test/random/`)

| File          | Purpose                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `file-gen.ts` | Shared batch generation: `generateAndApplyFileOps()`, `FileOpTarget` interface |
| `actions.ts`  | Action definitions for the random walker (including `fileOps` batch action)    |
| `harness.ts`  | `WalkHarness` interface, `VirtualHarness`                                      |
| `walker.ts`   | Walk engine: `runWalk()`, `queryState()`, `pickAction()`                       |
| `rng.ts`      | `SeededRNG` — deterministic xorshift128+ PRNG                                  |

## Database schema

```sql
traces (
  trace_id  INTEGER PRIMARY KEY,
  seed      INTEGER NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT datetime('now')
)

steps (
  step_id   INTEGER PRIMARY KEY,
  trace_id  INTEGER REFERENCES traces(trace_id),
  seq       INTEGER NOT NULL,        -- 0-based position in trace
  command   TEXT NOT NULL,            -- git command, FILE_BATCH:<seed>, or FILE_WRITE/DELETE
  exit_code INTEGER NOT NULL,
  stdout    TEXT,
  stderr    TEXT,
  snapshot  TEXT NOT NULL,            -- JSON GitSnapshot
  UNIQUE(trace_id, seq)
)
```
