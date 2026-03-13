# just-git

Git implementation running inside the just-bash virtual shell. All commands operate on an in-memory virtual filesystem — nothing touches real disk.

## Runtime

- **Bun** — runtime, test runner, package manager. No Node/npm/pnpm/Vite.
- **TypeScript** strict mode, ESNext target, bundler module resolution.
- `bun test` to run tests. No build step.

## Architecture

### Operator API (`src/git.ts`, `src/hooks.ts`)

`createGit(options?)` returns a `Git` instance — the top-level entry point for sandbox operators. Provides hooks, middleware, identity/credential overrides, and command restriction without touching internals.

```ts
const git = createGit({
  identity: { name: "Agent", email: "agent@sandbox.dev", locked: true },
  disabled: ["push", "rebase", "remote", "clone", "fetch", "pull"],
  credentials: async (url) => ({ type: "bearer", token: "..." }),
});

git.on("pre-commit", (event) => {
  /* inspect index, abort if needed */
});
git.on("post-commit", (event) => {
  /* audit log */
});
git.use(async (event, next) => {
  /* timing, allowlists, transforms */
});

const bash = new Bash({ cwd: "/repo", customCommands: [git] });
```

**`GitOptions`:**

- `disabled` — `GitCommandName[]` of subcommands to exclude from registration. Disabled commands return unknown-command errors.
- `identity` — `IdentityOverride` with `name`, `email`, optional `locked`. When `locked: true`, overrides env vars (`GIT_AUTHOR_NAME`, etc.); when unlocked (default), acts as fallback when env vars and git config are absent.
- `credentials` — `CredentialProvider` callback `(url) => HttpAuth | null`. Provides auth for Smart HTTP transport. Takes precedence over `GIT_HTTP_BEARER_TOKEN`/`GIT_HTTP_USER` env vars.

**Hooks** (`git.on(event, handler)` → unsubscribe function):

Pre-hooks can abort operations by returning `{ abort: true, message?: string }`:

- `pre-commit` — `{ index, treeHash }`. Fires before commit is created.
- `commit-msg` — `{ message }` (mutable). Fires after pre-commit, before commit write.
- `merge-msg` — `{ message, treeHash, headHash, theirsHash }` (mutable message). Fires before merge commit.
- `pre-merge-commit` — `{ mergeMessage, treeHash, headHash, theirsHash }`. Fires before three-way merge commit.
- `pre-checkout` — `{ target, mode }`. `mode` is `"switch" | "detach" | "create-branch" | "paths"`.
- `pre-push` — `{ remote, url, refs[] }`. Fires before object transfer.
- `pre-fetch` — `{ remote, url, refspecs, prune, tags }`. Fires before fetch.
- `pre-clone` — `{ repository, targetPath, bare, branch }`. Fires before clone.
- `pre-pull` — `{ remote, branch }`. Fires before pull.
- `pre-rebase` — `{ upstream, branch }`. Fires before rebase begins.
- `pre-reset` — `{ mode, target }`. `mode` is `"soft" | "mixed" | "hard" | "paths"`.
- `pre-clean` — `{ dryRun, force, removeDirs, removeIgnored, onlyIgnored }`.
- `pre-rm` — `{ paths, cached, recursive, force }`.
- `pre-cherry-pick` — `{ mode, commit }`. `mode` is `"pick" | "continue" | "abort"`.
- `pre-revert` — `{ mode, commit }`. `mode` is `"revert" | "continue" | "abort"`.
- `pre-stash` — `{ action, ref }`. `action` is `"push" | "pop" | "apply" | ...`.

Post-hooks are fire-and-forget (return value ignored):

- `post-commit` — `{ hash, message, branch, parents, author }`.
- `post-merge` — `{ headHash, theirsHash, strategy, commitHash }`. `strategy` is `"fast-forward"` or `"three-way"`.
- `post-checkout` — `{ prevHead, newHead, isBranchCheckout }`.
- `post-push` — same payload as `pre-push`.
- `post-fetch` — `{ remote, url, refsUpdated }`.
- `post-clone` — `{ repository, targetPath, bare, branch }`.
- `post-pull` — `{ remote, branch, strategy, commitHash }`.
- `post-reset` — `{ mode, targetHash }`.
- `post-clean` — `{ removed, dryRun }`.
- `post-rm` — `{ removedPaths, cached }`.
- `post-cherry-pick` — `{ mode, commitHash, hadConflicts }`.
- `post-revert` — `{ mode, commitHash, hadConflicts }`.
- `post-stash` — `{ action, ok }`.

Low-level events (fire-and-forget, no abort):

- `ref:update` — receives `{ ref, oldHash, newHash }`. Fires on any ref write.
- `ref:delete` — receives `{ ref, oldHash }`. Fires on ref deletion.
- `object:write` — receives `{ type, hash }`. Fires on every object written to the store.

**Middleware** (`git.use(fn)` → unsubscribe function):

Wraps every `git <subcommand>` invocation. Receives `(event, next)` where `event` is a `CommandEvent` containing the execution context: `{ command, rawArgs, fs, cwd, env, stdin, exec?, signal? }`. Call `next()` to proceed; return an `ExecResult` to short-circuit. Middlewares compose in registration order (first registered runs outermost).

**`GitExtensions`** — internal bundle threaded into command handlers via closures. Contains `hooks?: HookEmitter`, `credentialProvider?`, `identityOverride?`, `fetchFn?`, `networkPolicy?`. Command handlers access these to emit events and resolve identity/credentials.

### Commands

Registered via `just-bash-util`'s command framework. Each file exports `register*Command(parent, ext?)` where `ext` is `GitExtensions`. Root command created in `commands/git.ts` via `createGitCommand(ext?, disabled?)`.

Handlers receive `(args, ctx, meta)`:

- `ctx.fs` — `IFileSystem` (virtual filesystem)
- `ctx.cwd` — current working directory
- `ctx.env` — `Map<string, string>` (use `.get()`, not bracket access)

Return `{ stdout, stderr, exitCode }`.

### GitContext

Threaded through all `lib/` functions:

```ts
interface GitContext {
  fs: IFileSystem;
  gitDir: string; // absolute path to .git
  workTree: string | null; // null for bare repos
}
```

Obtain via `findGitDir(ctx.fs, ctx.cwd)` from `lib/repo.ts`, or `initRepository` for `git init`.

### Object storage

`PackedObjectStore` (`lib/object-store.ts`) handles all object I/O. New objects are written as zlib-compressed loose files at `.git/objects/<2hex>/<38hex>`, matching real Git's on-disk format. Packfiles received via fetch/clone are retained on disk with v2 `.idx` files and read via `PackReader`. `gc`/`repack` consolidate loose objects into delta-compressed packs.

Pack files live at `.git/objects/pack/pack-<hash>.{pack,idx}`. Index uses Git binary v2 format with 8-byte alignment and SHA-1 checksum.

### Pack format (`lib/pack/`)

Binary format codecs for Git's packfile and index formats, plus compression primitives. These are used by both the object storage layer and the transfer layer.

- **Packfiles** (`lib/pack/packfile.ts`) — reads/writes Git v2 packfiles with zlib-compressed entries. Supports `OFS_DELTA` and `REF_DELTA` on read; writes undeltified packs.
- **Pack index** (`lib/pack/pack-index.ts`) — reads/writes Git pack index v2 (`.idx`) files. Provides `PackIndex` for O(log N) hash lookups, `buildPackIndex` to generate an index from a packfile.
- **Pack reader** (`lib/pack/pack-reader.ts`) — `PackReader` for random-access object reads from a `.pack` + `.idx` pair. Resolves OFS_DELTA and REF_DELTA on demand.
- **CRC32** (`lib/pack/crc32.ts`) — ISO 3309 CRC32 for pack index checksums.
- **Zlib** (`lib/pack/zlib.ts`) — platform-adaptive zlib deflate/inflate (Bun/Node/browser).

### Transfer architecture (`lib/transport/`)

Object transfer between repositories:

1. **Transport** (`lib/transport/transport.ts`) — abstracts inter-repo communication. `LocalTransport` handles same-filesystem transfers; `SmartHttpTransport` handles real Git servers via HTTP(S).
2. **Smart HTTP protocol** (`lib/transport/smart-http.ts` + `lib/transport/pkt-line.ts`) — Git Smart HTTP Protocol v1 client. pkt-line framing, side-band-64k demuxing, capability negotiation, ref discovery, fetch-pack, and push-pack.
3. **Object walk** (`lib/transport/object-walk.ts`) — reachability-based enumeration for pack negotiation (want/have).
4. **Refspecs** (`lib/transport/refspec.ts`) — maps remote refs to local refs during fetch/push.

### Data flow (commit)

1. `stageFile` → reads file, writes blob, updates index
2. `writeIndex` → serializes to `.git/index`
3. `buildTreeFromIndex` → flat index entries to nested tree objects
4. Commit object created, `updateRef` advances branch

### Symlink support

Symlinks are stored as tree entries with mode `120000`. The blob content is the symlink target path (not the target file content). The `FileSystem` interface exposes optional `lstat()`, `readlink()`, and `symlink()` methods; when unavailable, symlinks degrade to `core.symlinks=false` behavior (plain files with target path as content).

Key behaviors:

- **Staging** (`stageFile`) — detects symlinks via `lstatSafe`, stores the link target as blob, mode `0o120000`.
- **Checkout** (`checkoutEntry`) — creates a real symlink via `fs.symlink()` for mode `120000` entries, falls back to `writeFile` when symlinks aren't supported.
- **Diff/status** — reads symlink targets via `readlink` for hashing and comparison; handles broken symlinks gracefully via `lstat`-based existence checks.
- **Worktree walk** (`walkWorkTree`) — uses `lstatSafe` to treat symlinks as leaf entries. Never recurses into symlinked directories (security/correctness).
- **Merge** — symlinks cannot be textually merged. Conflicting symlink changes produce all-or-nothing conflicts; non-conflicting changes resolve by taking the modified side.

## File reference

See [FILE_REFERENCE.md](FILE_REFERENCE.md) for exported functions, types, and classes from each file. Regenerate with `bun scripts/gen-lib-reference.ts > FILE_REFERENCE.md`.

### `src/index.ts` — Package exports

Re-exports `createGitCommand` (low-level), `createGit`, `Git`, `GitOptions`, `GitCommandName`, `GitExtensions`, `HookEmitter`, and all hook event/type interfaces from `src/git.ts` and `src/hooks.ts`.

### `src/git.ts` — Git class and factory

- `createGit(options?)` → `Git` — factory function
- `Git` class — holds `HookEmitter`, middleware stack, `GitExtensions`, disabled command set. Directly satisfies just-bash `Command` interface (pass `git` into `customCommands` without wrapping)
- `Git.on(event, handler)` → unsubscribe — delegates to `HookEmitter`
- `Git.use(middleware)` → unsubscribe — registers command middleware
- `Git.name` — always `"git"`, satisfies just-bash `Command` interface
- `Git.execute(args, ctx)` — runs the git command with middleware wrapping; satisfies just-bash `Command` interface

**Types:** `GitOptions`, `GitCommandName`, `GitExtensions`, `CommandContext`, `CommandExecOptions`.

### `src/hooks.ts` — Hooks, middleware, and event types

- `HookEmitter` class — typed event emitter with `on(event, handler)` → unsubscribe, `emitPre(event, data)` → `AbortResult | null`, `emit(event, data)` (fire-and-forget)
- `CredentialProvider` type — `(url: string) => HttpAuth | null | Promise<HttpAuth | null>`
- `IdentityOverride` interface — `{ name, email, locked? }`
- `CommandEvent` interface — `{ command, rawArgs, fs, cwd, env, stdin, exec?, signal? }` for middleware.
- `Middleware` type — `(event: CommandEvent, next: () => Promise<ExecResult>) => ExecResult | Promise<ExecResult>`

**Event types:** `PreCommitEvent`, `CommitMsgEvent`, `MergeMsgEvent`, `PostCommitEvent`, `PreMergeCommitEvent`, `PostMergeEvent`, `PreCheckoutEvent`, `PostCheckoutEvent`, `PrePushEvent`, `PostPushEvent`, `PreFetchEvent`, `PostFetchEvent`, `PreCloneEvent`, `PostCloneEvent`, `PrePullEvent`, `PostPullEvent`, `PreRebaseEvent`, `PreResetEvent`, `PostResetEvent`, `PreCleanEvent`, `PostCleanEvent`, `PreRmEvent`, `PostRmEvent`, `PreCherryPickEvent`, `PostCherryPickEvent`, `PreRevertEvent`, `PostRevertEvent`, `PreStashEvent`, `PostStashEvent`, `RefUpdateEvent`, `RefDeleteEvent`, `ObjectWriteEvent`. Map: `HookEventMap`.

### Lib modules

| File                           | Purpose                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `lib/types.ts`                 | Core types: `ObjectId`, `Commit`, `Tree`, `Index`, `GitContext`, etc.                                |
| `lib/sha1.ts`                  | SHA-1 hashing (platform-adaptive)                                                                    |
| `lib/object-db.ts`             | Object store: read/write/hash git objects                                                            |
| `lib/objects/`                 | Parse/serialize by type (tree, commit, tag)                                                          |
| `lib/refs.ts`                  | Reference management: read, resolve, update, delete, list                                            |
| `lib/index.ts`                 | Staging area (index): read/write, add/remove entries                                                 |
| `lib/repo.ts`                  | Repository discovery (`findGitDir`) and `initRepository`                                             |
| `lib/config.ts`                | Git config (INI format): get/set/unset values                                                        |
| `lib/identity.ts`              | Author/committer resolution from env vars and config                                                 |
| `lib/tree-ops.ts`              | `buildTreeFromIndex`, `flattenTree`, `diffTrees`                                                     |
| `lib/worktree.ts`              | Working tree: diff, checkout, stage, walk (with .gitignore and symlink support)                      |
| `lib/symlink.ts`               | Symlink helpers: `lstatSafe`, `isSymlinkMode`, `readWorktreeContent`, `hashWorktreeEntry`            |
| `lib/ignore.ts`                | Full .gitignore implementation: parse, match, hierarchical stacking                                  |
| `lib/wildmatch.ts`             | Port of git's `wildmatch.c` — glob pattern matching                                                  |
| `lib/pathspec.ts`              | Pathspec parsing/matching with magic prefixes                                                        |
| `lib/diff-algorithm.ts`        | Myers diff + unified diff format                                                                     |
| `lib/diff3.ts`                 | Three-way content merge (Hunt-McIlroy LCS)                                                           |
| `lib/combined-diff.ts`         | Combined diff formatting for merge commits                                                           |
| `lib/merge.ts`                 | Merge base finding (`findAllMergeBases`) + fast-forward handling                                     |
| `lib/merge-ort.ts`             | Merge-ort strategy: tree-level three-way merge with rename detection                                 |
| `lib/unpack-trees.ts`          | Tree unpacking engine (checkout/merge/reset core), modeled after git's `unpack-trees.c`              |
| `lib/commit-walk.ts`           | Commit graph traversal, ahead/behind counts, orphan detection                                        |
| `lib/rev-parse.ts`             | Revision string resolution (`HEAD~2`, `main^{commit}`, short hashes)                                 |
| `lib/reflog.ts`                | Reflog read/write/append in standard git format                                                      |
| `lib/stash.ts`                 | Stash operations: save, apply, drop, list, clear                                                     |
| `lib/rebase.ts`                | Rebase state persistence and todo list management                                                    |
| `lib/operation-state.ts`       | State files: `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `ORIG_HEAD`, `MERGE_MSG`                              |
| `lib/checkout-utils.ts`        | Shared helpers for checkout/switch/restore commands                                                  |
| `lib/command-utils.ts`         | Shared command helpers: context requirements, formatting                                             |
| `lib/commit-summary.ts`        | Diffstat and commit summary formatting                                                               |
| `lib/status-format.ts`         | Long-form status output with staged/unmerged/untracked sections                                      |
| `lib/log-format.ts`            | Log format string expansion (`--format`/`--pretty`)                                                  |
| `lib/rename-detection.ts`      | Content-similarity rename detection for tree diffs                                                   |
| `lib/patch-id.ts`              | Patch ID computation for rebase deduplication                                                        |
| `lib/range-syntax.ts`          | `A..B` and `A...B` range syntax parsing                                                              |
| `lib/date.ts`                  | Date parsing/formatting for `--since`/`--until` and log output                                       |
| `lib/path.ts`                  | Pure path utilities (join, resolve, dirname, basename, relative)                                     |
| `lib/pack/packfile.ts`         | Git v2 packfile read/write with zlib compression                                                     |
| `lib/pack/pack-index.ts`       | Pack index v2 reader (`PackIndex`), writer (`writePackIndex`), builder (`buildPackIndex`)            |
| `lib/pack/pack-reader.ts`      | Random-access pack reader (`PackReader`): reads objects from `.pack` + `.idx` pairs, resolves deltas |
| `lib/pack/crc32.ts`            | CRC32 (ISO 3309) for pack index construction                                                         |
| `lib/pack/zlib.ts`             | Zlib deflate/inflate abstraction                                                                     |
| `lib/transport/transport.ts`   | Transport layer: `LocalTransport` and `SmartHttpTransport`                                           |
| `lib/transport/smart-http.ts`  | Git Smart HTTP Protocol v1 client                                                                    |
| `lib/transport/pkt-line.ts`    | pkt-line wire framing and side-band-64k demuxing                                                     |
| `lib/transport/object-walk.ts` | Object reachability enumeration for pack negotiation                                                 |
| `lib/transport/refspec.ts`     | Refspec parsing and ref mapping                                                                      |
| `lib/transport/remote.ts`      | Remote name → transport resolution via git config                                                    |

## Commands

| Command           | File                      | Summary                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git init`        | `commands/init.ts`        | `init`, `init <dir>`, `init --bare`, `--initial-branch <name>`                                                                                                                                                                                                                                                                                 |
| `git clone`       | `commands/clone.ts`       | `clone <repo> [<dir>]`, `--bare`, `-b <branch>`. Supports local paths and HTTP(S) URLs (Smart HTTP protocol). Uses `symref` capability for default branch detection with HTTP remotes. Sets up origin remote, remote tracking refs, branch tracking config, checks out working tree + index. Writes reflog for HEAD, branch, and tracking refs |
| `git fetch`       | `commands/fetch.ts`       | `fetch [<remote>] [<refspec>...]`, `--tags`, `--prune`/`-p`. Updates remote tracking refs, writes `FETCH_HEAD`. Uses configured fetch refspec from remote config. Writes reflog for all updated tracking refs                                                                                                                                  |
| `git push`        | `commands/push.ts`        | `push [<remote>] [<refspec>...]`, `--force`/`-f`, `-u`/`--set-upstream`, `--all`, `--tags`, `--delete`/`-d`. Transfers objects and updates remote refs. Proper fast-forward ancestry check via `isAncestor`. `--delete` removes remote refs cleanly                                                                                            |
| `git pull`        | `commands/pull.ts`        | `pull [<remote>] [<branch>]`, `--ff-only`, `--no-ff`. Fetch + merge (FF or three-way via merge-ort). Reads tracking branch config for defaults. Writes `FETCH_HEAD`. Writes reflog for tracking refs and branch/HEAD updates. Uses `handleFastForward` and `advanceBranchRef` from lib                                                         |
| `git add`         | `commands/add.ts`         | Stage files/dirs, `git add .`, glob pathspecs (`git add '*.ts'`), handles deletions                                                                                                                                                                                                                                                            |
| `git rm`          | `commands/rm.ts`          | Remove from worktree + index. `--cached`, `-r`, `-f`. Glob pathspecs (`git rm '*.log'`)                                                                                                                                                                                                                                                        |
| `git commit`      | `commands/commit.ts`      | `-m`, `--allow-empty`, `--amend`, `--no-edit`, `-a`. Merge/cherry-pick/rebase-aware (reads `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REBASE_HEAD`, `MERGE_MSG`, blocks on unresolved conflicts, preserves original author during cherry-pick/rebase/amend)                                                                                            |
| `git status`      | `commands/status.ts`      | Staged, unmerged (with conflict labels), unstaged, untracked sections. Shows rebase-in-progress indicator. `-s`/`--short`, `--porcelain`, `-b`/`--branch`                                                                                                                                                                                      |
| `git log`         | `commands/log.ts`         | `--oneline`, `-n <count>`, `--all`, `--reverse`, `A..B`, `A...B`, `-- <path>` (pathspec globs), `--author=<pattern>`, `--grep=<pattern>`, `--since`/`--after`/`--until`/`--before`, `--decorate`. Accepts `<ref>` starting points (e.g. `git log main`)                                                                                        |
| `git diff`        | `commands/diff.ts`        | Unstaged, `--cached`, `diff <commit>`, `diff <commit> <commit>`. Pathspec filtering via `-- <pathspec>` (supports globs)                                                                                                                                                                                                                       |
| `git branch`      | `commands/branch.ts`      | List (`*` current), create (with optional start-point: `branch <name> <commit>`), delete (`-d`/`-D`), rename (`-m`), `-r`/`-a` remote/all listing, `-u`/`--set-upstream-to` tracking config, `-v`/`-vv` verbose with ahead/behind counts                                                                                                       |
| `git tag`         | `commands/tag.ts`         | Lightweight, annotated (`-a -m`), list, delete (`-d`), `-l <pattern>` (glob filter), `git tag <name> <commit>`, `-f` (force overwrite)                                                                                                                                                                                                         |
| `git checkout`    | `commands/checkout.ts`    | Branch switch via `checkoutTrees()` from unpack-trees. `-b` create+switch. Detached HEAD checkout (commit hash, tag). File restore from index or commit tree (`git checkout HEAD~1 -- file.txt`), pathspec globs. `--ours`/`--theirs` for conflict resolution                                                                                  |
| `git reset`       | `commands/reset.ts`       | Path unstaging with pathspec globs (`git reset -- '*.ts'`), `--soft`/`--mixed`/`--hard`. Uses `resetHard()` from unpack-trees for `--hard`                                                                                                                                                                                                     |
| `git merge`       | `commands/merge.ts`       | FF via `handleFastForward()`, three-way via `mergeOrtRecursive` + `checkThreeWayMergePreconditions`. `--no-ff`, `-m <message>`, `--abort` via `mergeAbort()`. Conflict markers, `MERGE_HEAD`/`ORIG_HEAD`/`MERGE_MSG`. Blocks if `CHERRY_PICK_HEAD` or rebase active                                                                            |
| `git rebase`      | `commands/rebase.ts`      | `rebase <upstream>`, `--onto <newbase>`, `--abort`, `--continue`, `--skip`. Cherry-picks commits onto new base using merge-ort. Patch-id deduplication to skip already-applied commits. Full state persistence for conflict resolution                                                                                                         |
| `git cherry-pick` | `commands/cherry-pick.ts` | Single-commit cherry-pick via three-way merge (base=parent, ours=HEAD, theirs=commit). `--abort`, `--continue`. Preserves original author. Writes `CHERRY_PICK_HEAD`/`ORIG_HEAD`/`MERGE_MSG` on conflict. Blocks if rebase active                                                                                                              |
| `git revert`      | `commands/revert.ts`      | Single-commit revert via three-way merge (base=commit, ours=HEAD, theirs=parent). `--abort`, `--continue`, `--no-commit`/`-n`, `-m <parent>` for merge commits. Writes `REVERT_HEAD`/`MERGE_MSG` on conflict. Uses current committer as author                                                                                                 |
| `git show`        | `commands/show.ts`        | `show [<object>]`, `show <rev>:<path>`. Displays commits (header + diff), annotated tags, trees (ls-tree format), blobs (raw content). Defaults to HEAD. Skips diff for merge commits                                                                                                                                                          |
| `git mv`          | `commands/mv.ts`          | `mv <src> <dst>`. Renames in worktree + index. `-f` force, `-n`/`--dry-run`. Detects conflicted sources                                                                                                                                                                                                                                        |
| `git stash`       | `commands/stash.ts`       | `push`/`pop`/`apply`/`list`/`drop`/`show`/`clear`. Accepts `stash@{N}` or plain number                                                                                                                                                                                                                                                         |
| `git remote`      | `commands/remote.ts`      | `add`, `remove`/`rm` (cleans tracking refs + branch config), `rename` (moves refs + updates refspec), `set-url`, `get-url`, list, `-v`. Config-based, no network                                                                                                                                                                               |
| `git config`      | `commands/config.ts`      | `get`, `set`, `unset`, `list` subcommands + legacy positional syntax (`git config <key> [<value>]`). `--list`/`-l`, `--unset` flags                                                                                                                                                                                                            |
| `git reflog`      | `commands/reflog.ts`      | `show [<ref>]` (default HEAD, newest-first, `-n`/`--max-count`), `exists <ref>` (exit 0 if reflog exists). Bare `git reflog` and `git reflog <ref>` also work as `show` aliases                                                                                                                                                                |
| `git clean`       | `commands/clean.ts`       | `-f`/`--force`, `-n`/`--dry-run`, `-d` (directories), `-x` (include ignored), `-X` (only ignored), `-e`/`--exclude=<pattern>`. Pathspec filtering. Requires `-f` by default (respects `clean.requireForce` config)                                                                                                                             |
| `git switch`      | `commands/switch.ts`      | `<branch>`, `-c`/`-C <branch> [<start-point>]` (create/force-create), `-d`/`--detach` (detach HEAD), `--orphan <branch>` (clears index and tracked worktree files), `-` (previous branch via reflog). `--guess` (default on) creates local branch from unique remote tracking match                                                            |
| `git restore`     | `commands/restore.ts`     | `<pathspec>...`, `-s`/`--source=<tree>` (source commit), `-S`/`--staged` (restore index), `-W`/`--worktree` (restore worktree, default), `-S -W` (both). `--ours`/`--theirs` for conflict resolution. Glob pathspecs supported                                                                                                                 |

## Testing

Tests in `test/` mirror source structure. Run with `bun test`.

### Test utilities (`test/util.ts`)

- `createTestBash(options?)` — `Bash` instance with git registered, cwd defaults to `/repo`
- `quickExec(command, options?)` — one-liner: run command, get result
- `runScenario(commands, options?)` — run command sequence against one bash instance
- FS helpers: `pathExists`, `readFile`, `isDirectory`, `isFile`
- `setupClonePair()` — init remote + clone to /local, returns shared Bash

### Fixtures (`test/fixtures.ts`)

`EMPTY_REPO`, `BASIC_REPO`, `NESTED_REPO` — common initial filesystem layouts.

`TEST_ENV` — standard test identity (`Test`/`test@test.com`) with deterministic timestamps.
`TEST_ENV_NAMED` — like `TEST_ENV` but with distinct author/committer names (`Test Author`/`Test Committer`).
`envAt(ts)` — returns `TEST_ENV_NAMED` with overridden timestamps.

### Initial files and env

```ts
await quickExec("git init", { files: { "/repo/README.md": "# Hello" } });
```

For commands needing identity, set env vars:

```ts
await quickExec('git commit -m "test"', {
  env: {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
    GIT_AUTHOR_DATE: "1000000000",
    GIT_COMMITTER_DATE: "1000000000",
  },
});
```

### Random walk engine (`test/random/`)

Reusable random walk engine for generating git operation sequences. Shared by oracle and standalone tools.

- `harness.ts` — `WalkHarness` interface, `VirtualHarness` (in-memory only), `ExecResult`, `DEFAULT_TEST_ENV`
- `types.ts` — `Action` interface (with `category` and `fuzz` param), `ActionCategory`, `FuzzConfig`
- `pickers.ts` — Shared value-selection helpers (`pickOtherBranch`, `pickFile`, `pickCommitHash`, `pickTag`, `pickRemote`, `pickAnyBranch`, `newBranchName`, `newTagName`, `inConflict`). Each picker accepts optional `{ fuzzRate }` to inject plausible-but-wrong values for error-path testing.
- `actions/` — Action definitions split by category:
  - `index.ts` — Re-exports `ALL_ACTIONS` (103 actions), `Action`, `ActionCategory`, per-category arrays
  - `file-ops.ts` — `fileOps` (seed-based file batch)
  - `staging.ts` — `addAll`, `addAllFlag`, `addSpecific`, `addUpdate`, `rmFile`, `rmCached`, `mvFile`
  - `commit.ts` — `commit`, `commitAll`, `commitAmend`, `commitAmendNoEdit`
  - `branch.ts` — `createBranch`, `checkoutOrphan`, `switchBranch`, `deleteBranch`, `branchForceDelete`, `branchRename`, `createBranchFromRef`, `detachedCheckout`, `checkoutFile`, `checkoutFileFromCommit`
  - `merge.ts` — `merge`, `mergeAbort`, `mergeContinue`
  - `rebase.ts` — `rebase`, `rebaseAbort`, `rebaseContinue`, `rebaseSkip`
  - `cherry-pick.ts` — `cherryPick`, `cherryPickX`, `cherryPickAbort`, `cherryPickContinue`, `cherryPickSkip`, `cherryPickNoCommit`
  - `revert.ts` — `revert`, `revertAbort`, `revertContinue`
  - `conflict.ts` — `resolveAndCommit`, `resolvePartial`, `checkoutOursTheirs`
  - `stash.ts` — `stashPush`, `stashPushUntracked`, `stashPop`, `stashApply`, `stashDrop`
  - `tag.ts` — `createTag`, `createTagAtCommit`, `deleteTag`, `listTags`
  - `remote.ts` — `remoteAdd`, `remoteRemove`, `remoteRename`, `remoteSetUrl`, `remoteGetUrl`, `remoteList`
  - `reset.ts` — `resetMixed`, `resetHard`, `resetSoft`, `resetFile`
  - `clean.ts` — `cleanWorkTree`, `toggleCleanRequireForce`
  - `switch.ts` — `switchBranchViaSwitch`, `switchCreate`, `switchCreateFromRef`, `switchForceCreate`, `switchDetach`, `switchOrphan`
  - `restore.ts` — `restoreWorktree`, `restoreStaged`, `restoreFromSource`, `restoreStagedAndWorktree`, `restoreOursTheirs`
  - `diagnostic.ts` — All read-only actions (log, status, diff, show, rev-parse, ls-files, reflog variants)
- `file-gen.ts` — File operation generation (`FileGenConfig`, `DEFAULT_FILE_GEN_CONFIG`, `WIDE_FILE_GEN_CONFIG`, `STRESS_FILE_GEN_CONFIG`, `GitignoreConfig`, `DEFAULT_GITIGNORE_PATTERNS`, `generateAndApplyFileOps`, `resolveAllFiles`). Normal file ops never create/edit `.gitignore` files; gitignore generation is controlled by `GitignoreConfig` in `FileGenConfig.gitignore`.
- `walker.ts` — Walk loop (`runWalk`, `pickAction(rng, state, actions?, chaosRate?)`, `queryState`), `StepEvent`, `WalkConfig` (includes `chaosRate` and `fuzz`)
- `rng.ts` — `SeededRNG` (deterministic PRNG)
- `stats.ts` — CLI: gather VFS statistics after a walk
- `bench.ts` — CLI: benchmark virtual-only walk throughput

**Action categories** (`ActionCategory` type): `file-ops`, `staging`, `commit`, `branch`, `merge`, `rebase`, `cherry-pick`, `revert`, `stash`, `tag`, `remote`, `reset`, `clean`, `config`, `conflict-resolution`, `diagnostic`, `maintenance`. Presets can filter/boost by category using `boostCategory()`, `excludeNames()` helpers in `generate.ts`.

**Fuzz config** (`FuzzConfig`): Per-picker-type probability of injecting wrong values. Fields: `branchRate`, `fileRate`, `commitRate`, `tagRate`, `remoteRate`. Threaded from `WalkConfig.fuzz` through `action.execute()` to pickers. Deterministic from seed — no storage changes needed.

**Gitignore generation** (`GitignoreConfig`): Optional per-batch probability of creating/modifying `.gitignore` files in the worktree. Fields: `rate` (probability per batch), `subdirRate` (probability of placing in subdir vs root), `patterns` (pool of patterns like `*.log`, `build/`, etc.). Enabled via `FileGenConfig.gitignore`.

### Oracle tests (`test/oracle/`)

Database-backed oracle testing framework. Generates traces by running random walks against real git, stores snapshots in SQLite, then replays against the virtual implementation and compares state.

**CLI**: `bun oracle <command>` (alias for `bun test/oracle/cli.ts`)

Quick start:

```bash
# 1) Generate traces
bun oracle generate basic --seeds 1-20 --steps 300

# 2) Replay against implementation
bun oracle test basic

# 3) Debug a divergence
bun oracle inspect basic 5 42
bun oracle rebuild basic 5 42

# 4) Generate clone-based traces (requires network)
bun oracle generate clone-cannoli --seeds 1-5 --steps 100
bun oracle test clone-cannoli
```

Commands:

- `generate [name] --seeds <spec> [--steps <n>] [--preset <name>] [--chaos <rate>] [--clone-url <url>]` — run random walks against real git and store traces. `--chaos` overrides preset's chaos rate. `--clone-url` starts each trace with `git clone <url> .` instead of `git init`.
- `test [name] [trace] [-v] [--stop-at N]` — replay traces against virtual impl and compare every step. Compares state (HEAD, refs, index, worktree), exit code, stdout, and stderr. Auto-logs results to `data/<name>/test-results.log`. PASS lines suppressed from console in non-verbose mode.
- `inspect <name> <trace> <step>` — show oracle + impl state side-by-side at a step, including exit code / stdout / stderr comparison with character-level diff on mismatch
- `trace-context <name> <trace> <step> [--before N]` — show preceding commands around a step (no replay, lightweight)
- `diff-worktree <name> <trace> <step> [--limit N]` — diff oracle vs impl worktree file paths
- `diff-file <name> <trace> <step> <path>` — show first line-level mismatch for one file
- `conflict-blobs <name> <trace> <step> <path> [--full]` — show stage 1/2/3 blob details for a conflicted path
- `rebuild <name> <trace> <step>` — materialize a real git repo at a step for manual inspection
- `size [name] [trace] [--every N] [--csv]` — replay traces and measure repo size growth. Shows worktree files/bytes, index entries, conflict entries, and object store stats at regular intervals. Default sampling every 200 steps.

Database naming/layout:

- First positional argument after subcommand is the DB name.
- Traces are stored at `test/oracle/data/<name>/traces.sqlite`.
- If `generate` omits `name`, default DB name is `default`.
- If `name` matches a preset and `--preset` is omitted, that preset is used.

Presets:

- `default`, `basic`, `core`, `rebase-heavy`, `merge-heavy`, `cherry-pick-heavy`, `no-rename-show`, `no-show`, `wide-files`, `chaos`, `chaos-heavy`, `clone-cannoli`, `clone-core`, `fuzz-light`, `fuzz-heavy`, `chaos-fuzz`, `gitignore`, `stress`
- `core` focuses on ~45 daily-use actions (add/commit/branch/merge/rebase/stash/reset/cherry-pick + essential diagnostics). Light chaos (5%) and fuzz (3%) for some error-path coverage. Best for exploring the state space of common workflows without noise from rare commands.
- `*-heavy` presets boost operation weights by category for targeted stress.
- `no-rename-show` excludes `mvFile` and `showHead` actions (avoids rename-detection ambiguity and combined-diff non-determinism).
- `no-show` excludes only `showHead` (allows renames via `mvFile`).
- `wide-files` uses `WIDE_FILE_GEN_CONFIG` (deeper dirs, larger files, 5% empties).
- `chaos` / `chaos-heavy` set `chaosRate` to bypass soft preconditions 12-20% of the time.
- `fuzz-light` / `fuzz-heavy` inject wrong values (non-existent branches, files, commits, tags, remotes) at 3% / 8-10% rates to exercise error handling.
- `chaos-fuzz` combines chaos mode (12%) with light fuzz (3%).
- `gitignore` enables `.gitignore` file generation at 5% per file-op batch.
- `clone-cannoli` clones from `https://github.com/DeabLabs/cannoli.git` instead of `git init`, then runs random walks. Requires network access for both generation and replay. Custom presets can specify `cloneUrl` or use `--clone-url <url>` on the CLI.
- `clone-core` combines the core action set with cloning from cannoli. Same chaos/fuzz as `core`. Requires network.
- `stress` builds very large repos for performance profiling. Uses `STRESS_FILE_GEN_CONFIG` (batches of 8-25, files 40-250 lines, 16 dir prefixes, 60% create bias). Boosts file-ops/commit/staging weights, reduces diagnostics/clean/reset. Best with high step counts (`--steps 2000` or more).

Comparison model:

- Replay compares state and output on every non-placeholder step.
- **State**: `head_ref`, `head_sha`, full `refs`, `index` (`path:stage`), `work_tree`, `active_operation`, `operation_state_hash`, `stashHashes`.
- **Output**: `exit_code`, `stdout`, `stderr`. Per-command skip lists bypass stdout/stderr for commands with known unimplemented output (see `checker.ts` tables). Merge-precondition stderr mismatches (file list differs but format matches) are tolerated to allow traces to continue past rename-detection differences.
- `work_tree` is hashed deterministically from sorted path/content.
- Operation state includes merge/cherry-pick/rebase control files.

Determinism:

- Generation and replay use incrementing commit timestamps (`1000000000 + counter`) for commit-producing commands (`commit`, `merge`, `cherry-pick`, `rebase --continue`) so hashes align between real git and virtual replay.

Placeholder snapshots:

- A walker action may emit multiple commands; only the last command in that grouped action gets a full snapshot.
- Earlier commands in the group store placeholder snapshots (`workTreeHash === ""`), and replay skips comparison for them.

Debug workflow:

1. `bun oracle test <name>` to locate first failing trace. Results are also saved to `data/<name>/test-results.log`.
2. `bun oracle test <name> <trace> -v` to inspect command-by-command path.
3. `bun oracle inspect <name> <trace> <step>` for full state + output diff at divergence.
4. `bun oracle trace-context <name> <trace> <step> --before 20` for more command history context.
5. `bun oracle diff-worktree <name> <trace> <step>` to compare worktree files.
6. `bun oracle diff-file <name> <trace> <step> <path>` for line-level file diff.
7. `bun oracle conflict-blobs <name> <trace> <step> <path>` for index stage blob details.
8. `bun oracle rebuild <name> <trace> <step>` for a real git repo to inspect manually.

**Key modules:**

- `cli.ts` — Unified CLI entry point
- `generate.ts` — Trace generation engine with action presets, `TraceConfig` (stored per-trace: `chaosRate` + `FileGenConfig`)
- `real-harness.ts` — `RealGitHarness` (WalkHarness backed by real git in temp dir), `buildRealGitEnv`
- `impl-harness.ts` — `captureImplState`, `replayAndCheck`, `replayToStateAndOutput` (virtual FS replay + state/output capture)
- `capture.ts` — Snapshot capture from real git repos (`captureSnapshot`, `captureStashHashes`, `hashWorkTree`)
- `compare.ts` — State comparison (`compare`, `matches`, `ImplState`, `OracleState`, `Divergence`)
- `checker.ts` — `BatchChecker` (loads oracle snapshots, checks impl state and output against them). Contains per-command stdout/stderr skip lists with documented rationale. Conditional matchers tolerate known cosmetic differences: `initOutputMatches` (path), `showDiffOutputMatches` (diff formatting), `diffHunkAlignmentMatches` (hunk boundaries), `mergeFastForwardOutputMatches` (FF summary), `rebaseStatusTodoOutputMatches` (rebase status), `mergeFamilyDiagnosticOutputMatches` (merge/cherry-pick/revert diagnostics), `renameCollisionOutputMatches` (rename collisions), `branchRebasingDetachedMatches` (branch status during rebase), `checkoutOrphanCountMatches` (orphan count), `mergeOverwriteStderrMatches` (rename file list), `worktreePathStderrMatches` (worktree path), `rebaseProgressStderrMatches` (rebase progress), `commitStatMatches` (diffstat counts).
- `post-mortem.ts` — Classifies divergences as known patterns vs genuine bugs (`PostMortemPattern` type). Runs planner comparisons for rebase, rename detection analysis for merge/cherry-pick. Known patterns: `rename-detection-ambiguity`, `merge-precondition-rename-paths`, `abort-untracked-conflict`, `merge-directory-rename`, `merge-recursive-base-rename2to1`, `rebase-planner-*`, `rebase-todo-diverged`, `diff3-ambiguity`.
- `fileops.ts` — File operation serialization (`isFileOp`, `parseFileOp`, `write`, `del`, `move`), `isCommitCommand`. Three trace formats: `FILE_BATCH:<seed>` (random ops), `FILE_RESOLVE:<seed>` (conflict resolution), `FILE_WRITE`/`FILE_DELETE` (legacy individual ops)
- `runner.ts` — `replayTo` (rebuild real git repo at a step for debugging)
- `schema.ts` — SQLite schema (`initDb`)
- `store.ts` — `OracleStore` (read/write traces and steps)
- `index.ts` — Re-exports for programmatic use

## Scope

init, clone, fetch, push, pull, add, rm, mv, commit, status, log, show, diff, branch, checkout, switch, restore, merge, rebase, cherry-pick, revert, reset, tag, stash, remote, config, clean. Local transport and Smart HTTP transport (clone/fetch/push against real Git servers like GitHub). Transfer uses real Git packfile format with zlib compression. HTTP auth via `GIT_HTTP_BEARER_TOKEN` or `GIT_HTTP_USER`/`GIT_HTTP_PASSWORD` env vars.
