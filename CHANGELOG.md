# Changelog

## 1.9.1

### Fixed

- `git -c <name>=<value> <cmd>` and `git -C <path> <cmd>` now run the command instead of printing help and exiting 0 ([#11](https://github.com/blindmansion/just-git/issues/11)). `-c` applies to that invocation only, above `.git/config` and below operator-locked values, and malformed keys fail with git's errors (exit 128). `-C` is repeatable, with each path resolved from the previous one. `-p` / `--paginate` / `-P` / `--no-pager` are accepted and ignored, `-v` / `-h` work as `--version` / `--help`, and any other leading option exits 129 with `unknown option`. Settings read directly from `.git/config` (such as `remote.<name>.url`, `branch.<name>.*`, and `push.default`) don't honor `-c` yet. Contributed by [Harry Nguyen (@Hazzng)](https://github.com/Hazzng) in [#13](https://github.com/blindmansion/just-git/pull/13).
- Operator config override keys (`createGit({ config })`) now match case-insensitively on the section and variable name, as in git, so `merge.conflictStyle` and `merge.conflictstyle` are the same key. `git config --list` prints operator keys in lowercase, like keys from `.git/config`.

## 1.9.0

### Added

- Support `-q` / `--quiet` on `init`, `clone`, `fetch`, `push`, `pull`, `commit`, `merge`, `rebase`, `checkout`, `switch`, `restore`, `reset`, `rm`, `clean`, `branch`, `gc`, `repack`, `show`, `log`, `rev-parse`, `grep`, `stash push`/`pop`/`apply`/`drop`, and `worktree add`, matching real git's output. `rebase -q` persists across `--continue` / `--skip`. Prompted by `commit -q` support from [Jeremy Geros (@JeremyGeros)](https://github.com/JeremyGeros) in [#7](https://github.com/blindmansion/just-git/pull/7).

### Fixed

- `merge --continue`/`--abort` and `rebase --continue`/`--abort`/`--skip` reject extra arguments with git's usage error and exit code 129.

## 1.8.3

### Added

- Honor `diff.renameLimit`, `merge.renameLimit`, and `status.renameLimit` with git's fallback rules and defaults (1000 for diff/status, 7000 for merge; `0` means unlimited). When inexact rename detection is skipped, `diff`, `log`, `show`, `merge`, and `pull` print git's "exhaustive rename detection was skipped" warning. Exact and basename matches are still found above the limit. The repo API's `DiffOptions` gains a matching `renameLimit` option.
- `FileStat` gains optional `ctime`, `dev`, `ino`, `uid`, and `gid` fields. Filesystems that expose them strengthen the index stat cache (below).

### Changed

- Worktree comparisons (`status`, `diff`, `commit -a`, `reset`, `describe --dirty`, …) now skip content hashing for tracked files whose size, mtime, and mode match the index, like real git's stat cache. Staging, clone, checkout/restore, and worktree creation record file metadata in the index; racily clean entries are smudged and always hashed. On a clean 8,000-file repo, `git diff HEAD --numstat` drops from ~770 ms to ~230 ms. **Custom `FileSystem` implementations must update `mtime` whenever file content changes** (return `new Date(0)` if modification times aren't tracked, which disables the shortcut).
- Faster worktree diffing: `status -uno`, `diff`, `commit -a`, and `reset` no longer walk the worktree for untracked files, pathspec-limited `diff` only inspects matching paths, dirty checks stop at the first difference, and each modified file is hashed once per command.

### Fixed

- `git describe --dirty` no longer treats untracked files as dirty.
- `git diff <commit>` now composes staged and unstaged changes the way git does: a staged deletion stays deleted even if an untracked file occupies the path, staged changes reverted in the worktree produce no diff, conflicted paths compare the worktree result against the commit, and clean committed symlinks no longer appear as modified.
- Serve protocol v0 upload-pack over SSH statefully. The server previously read the whole request before replying, so shallow clones and fetches with many local-only commits hung against stateful SSH clients. It now sends the shallow update after the want section and ACK/NAK after each batch of haves, like git's upload-pack.
- The `ssh2` adapter example in the server docs now waits for each `stream.write` and closes with `stream.end()`, so packs larger than the SSH window are no longer truncated. Update adapters copied from the old example.

## 1.8.2

### Added

- `git status` now supports `--untracked-files` / `-u` with modes `no`, `normal` (default), and `all`, including git's attached-value forms (`-uno`, `-uall`) and the bare form (`-u` / `--untracked-files` means `all`). Long-format output matches real git's `-uno` wording ("Untracked files not listed…" / "nothing to commit (use -u to show untracked files)").
- The argument parser supports git-style optional-value options (`impliedValue`, git's `PARSE_OPT_OPTARG`): a bare optional-value option (`-u`, `--foo`) takes its implied value and never consumes the next token, while attached values (`-uno`, `--foo=no`) still win.

### Fixed

- Honor `core.autocrlf` line-ending conversion. Previously the setting was stored but never acted on: on a Windows-style checkout (CRLF worktree, LF blobs) every text file showed as perpetually modified, `git diff` reported whole-file rewrites, and `git add` committed spurious full-file changes. Now `true`/`input` normalize CRLF → LF on checkin and worktree comparison (status, diff, add, stash, rm, ls-files, checkout safety), and `true` converts LF → CRLF on checkout. Includes git's renormalization guard: files whose repo blob deliberately contains CRLF are left untouched. Binary content is never converted. `.gitattributes` (`text`/`eol`) is still not consulted.

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
