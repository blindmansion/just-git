# Changelog

## 1.8.1

### Fixed

- Accept CRLF line endings in ignore files. A `.gitignore` (or `info/exclude` / `core.excludesFile`) with Windows line endings silently lost all its patterns, so ignored files showed up as untracked and could be added or committed.
- Handle CRLF line terminators in config-file backslash continuations, and keep interior CRs as value content, matching real git.

## 1.8.0

### Added

- Add `git worktree` command with linked-worktree support: `add`, `list`, `remove`, `prune`, `lock`, `unlock`, `move`, and `repair` subcommands. Linked-worktree support courtesy of [Iain Lane (@iainlane)](https://github.com/iainlane).
- Add `--ignore-other-worktrees` to `git checkout` and `git switch`.
- `git log` (default and `--all`) now includes linked-worktree HEADs, and `git gc` keeps commits reachable from every worktree's HEAD and reflog.

### Fixed

- Fix a decompression deadlock in the smart-HTTP server: gzip request bodies inflating past the stream high-water mark could hang the handler. The body is now drained concurrently and canceled when the inflated-size limit is exceeded.
- Read and write `.git/config` from the common dir so config is shared across linked worktrees.
- Honor `gc.reflogExpire` / `gc.reflogExpireUnreachable`, including per-worktree reflogs.
- Merge/pull/rebase fidelity fixes: `merge --squash`/`--no-ff` fast-forward and conflict handling, `pull --rebase` output and no-op HEAD reflog entries, rebase reflog entries on fast-forward finish, `# empty` annotation in the rebase todo, and up-to-date vs cherry-pick-skip output.
- Abbreviated commit hashes in output now extend until unambiguous, matching git's `find_unique_abbrev` instead of a fixed length.

### Internal

- The oracle test harness is now worktree-aware, with a reworked trace schema (v1 → v4): per-worktree snapshots, a per-step working-directory dimension, and path-keyed comparison. A schema-version guard rejects stale trace DBs, so **oracle traces from earlier versions must be regenerated** (`bun oracle generate <name> …`).
- Isolate the test suite's `git` invocations from the developer's global/user git config. Also [Iain Lane (@iainlane)](https://github.com/iainlane).

## 1.7.0

- Add CORS proxy server (`just-git/proxy`) for browser-based clients — forwards git smart HTTP requests with CORS headers and request filtering.
- Add `git shortlog` command with `-s`, `-n`, `-e`, `--group`, `--format`, `--no-merges`, revision ranges, and pathspec filtering.
- Add `git log --skip=<n>` flag.
- Add `git tag --sort=<key>` flag.
