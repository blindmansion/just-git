# How just-git is tested

just-git targets faithful reproduction of real git's behavior: not just the happy path, but edge cases, error messages, conflict handling, and state transitions. This document explains how that fidelity is validated.

## Oracle testing

The primary validation tool is an **oracle testing framework** that compares just-git against real git across randomized workflows.

The process:

1. **Generate**: A random walker produces sequences of git operations (commits, merges, rebases, cherry-picks, stash, reset, clean, etc.) and runs them against real git, recording the full repository state after every step.
2. **Replay**: The same sequence is replayed against just-git's virtual implementation.
3. **Compare**: At every step, repository state and command output are compared.

What gets compared at each step:

| Category | Fields                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State    | HEAD ref and SHA, all refs, index entries (with conflict stages), worktree contents, active operation (merge/rebase/cherry-pick), operation state files, stash entries |
| Output   | Exit code, stdout, stderr                                                                                                                                              |

The full current test suite we're validating against covers thousands of traces totalling millions of operations across multiple presets. The `core` preset focuses on daily-use commands with light chaos and fuzz injection. The `kitchen` preset enables everything: chaos mode, fuzz injection, gitignore generation, and nearly all 135 available actions. A quick `bun oracle validate` run covers a smaller representative sample (~10 traces, ~3,000 operations) for fast feedback.

### Running it yourself

```bash
# Quick validation — generates traces against real git, then replays against just-git
# Covers core commands and kitchen-sink scenarios (~10 traces, ~3,000 operations)
bun oracle validate

# Or run the presets individually with more seeds for deeper coverage
bun oracle generate core --seeds 1-20 --steps 300
bun oracle test core

bun oracle generate kitchen --seeds 1-20 --steps 300
bun oracle test kitchen
```

Oracle trace generation requires git 2.53.x (the version just-git targets). The generator warns if your git version doesn't match, since version differences in output or behavior will cause false test failures.

### What the results look like

```
  PASS   trace 1   302 steps
  PASS   trace 2   302 steps
  KNOWN  trace 3   step 187/302  git merge --no-ff branch-2
         rename-detection-ambiguity: ...
  PASS   trace 4   302 steps

3 passed, 1 known  (4 total)
```

- **PASS**: Every step matched real git in both state and output.
- **KNOWN**: A divergence was detected but classified as a known, acceptable difference (e.g. rename detection tiebreaking; see below).
- **WARN**: A non-critical output difference (e.g. diff hunk boundary tiebreaking).
- **FAIL**: A genuine divergence that indicates a bug.

### Known acceptable differences

Some behaviors are intentionally different or have inherent non-determinism:

- **Rename detection tiebreaking**: When multiple deleted files share the same content, the pairing with added files is ambiguous. Real git's tiebreaking depends on internal hashmap iteration order. Our implementation uses sorted arrays with basename-first matching. Both are valid; neither is "correct."
- **Rebase planner subset**: Our planner computes exact set differences via full BFS. Git's timestamp-ordered walker can include false positives when commit timestamps are non-monotonic. Our result is mathematically more correct but occasionally smaller.
- **Conflict marker alignment**: The exact placement of conflict marker boundaries can differ between git's `xdl_merge` zealous mode and our diff3 implementation. Both produce correct, resolvable markers.

These are documented in detail in the [oracle README](../test/oracle/README.md).

## Unit and integration tests

Beyond oracle testing, `bun test` runs focused unit and integration tests covering individual commands, edge cases, hooks, transport, and internal data structures. These are faster to run and easier to debug than oracle traces, but cover less of the interaction surface.

## Interop tests

When backed by a real filesystem (`ReadWriteFs`), just-git can operate on the same repository as real git. The interop test suite verifies this by running operations through both just-git and real git on the same directory and comparing results.

## Try it yourself

The sandbox CLI lets you run git commands interactively against just-git backed by a real filesystem:

```bash
bun sandbox "git init"
bun sandbox "echo 'hello world' > README.md"
bun sandbox "git add ."
bun sandbox 'git commit -m "first commit"'
bun sandbox "git log --oneline"

# The .sandbox/ directory is a real directory — inspect it with real git too
cd .sandbox && git log --oneline
```

See [sandbox usage](#sandbox) for details. Run `bun sandbox --reset` to start fresh.
