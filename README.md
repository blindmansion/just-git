# just-git

[![CI](https://github.com/blindmansion/just-git/actions/workflows/ci.yml/badge.svg)](https://github.com/blindmansion/just-git/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/just-git)](https://www.npmjs.com/package/just-git)

Git implementation for virtual bash environments (particularly [just-bash](https://github.com/vercel-labs/just-bash)). Pure TypeScript, zero dependencies. Works in Node, Bun, Deno, and the browser. ~100 kB gzipped.

## Install

```bash
npm install just-git
```

## Quick start

```ts
import { Bash } from "just-bash";
import { createGit } from "just-git";

const git = createGit({
  identity: { name: "Alice", email: "alice@example.com" },
});

const bash = new Bash({
  cwd: "/repo",
  customCommands: [git],
});

await bash.exec("git init");
await bash.exec("echo 'hello' > README.md");
await bash.exec("git add .");
await bash.exec('git commit -m "initial commit"');
await bash.exec("git log --oneline");
```

## Options

`createGit(options?)` accepts:

| Option          | Description                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`      | Author/committer override. With `locked: true`, always wins over env vars and git config. Without `locked`, acts as a fallback.                                     |
| `credentials`   | `(url) => HttpAuth \| null` callback for Smart HTTP transport auth.                                                                                                 |
| `disabled`      | `GitCommandName[]` of subcommands to block (e.g. `["push", "rebase"]`).                                                                                             |
| `network`       | `{ allowed?: string[], fetch?: FetchFunction }` to restrict HTTP access and/or provide a custom `fetch` implementation. Set to `false` to block all network access. |
| `resolveRemote` | `(url) => GitContext \| null` callback for cross-VFS remote resolution. See [Multi-agent collaboration](#multi-agent-collaboration).                                |

```ts
const git = createGit({
  identity: { name: "Agent Bot", email: "bot@company.com", locked: true },
  credentials: async (url) => ({ type: "bearer", token: "ghp_..." }),
  disabled: ["rebase"],
  network: { allowed: ["github.com"], fetch: customFetch },
});
```

## Middleware

Middleware wraps every `git <subcommand>` invocation. Each middleware receives a `CommandEvent` and a `next()` function. Call `next()` to proceed, or return an `ExecResult` to short-circuit. Middlewares compose in registration order (first registered = outermost).

The `CommandEvent` provides the execution context: `{ command, rawArgs, fs, cwd, env, stdin }`, plus optional `exec` and `signal` when available.

```ts
// Audit log — record every command the agent runs
git.use(async (event, next) => {
  const result = await next();
  auditLog.push({ command: `git ${event.command}`, exitCode: result.exitCode });
  return result;
});

// Gate pushes on human approval
git.use(async (event, next) => {
  if (event.command === "push" && !(await getHumanApproval(event.rawArgs))) {
    return { stdout: "", stderr: "Push blocked — awaiting approval.\n", exitCode: 1 };
  }
  return next();
});

// Block commits that add large files (uses event.fs to read the worktree)
git.use(async (event, next) => {
  if (event.command === "add") {
    for (const path of event.rawArgs.filter((a) => !a.startsWith("-"))) {
      const resolved = path.startsWith("/") ? path : `${event.cwd}/${path}`;
      const stat = await event.fs.stat(resolved).catch(() => null);
      if (stat && stat.size > 5_000_000) {
        return { stdout: "", stderr: `Blocked: ${path} exceeds 5 MB\n`, exitCode: 1 };
      }
    }
  }
  return next();
});
```

`git.use()` returns an unsubscribe function to remove the middleware dynamically.

## Hooks

Hooks fire at specific points inside command execution (after middleware, inside operation logic). Register with `git.on(event, handler)`, which returns an unsubscribe function.

### Pre-hooks

Pre-hooks can abort the operation by returning `{ abort: true, message? }`.

```ts
// Block secrets from being committed
git.on("pre-commit", (event) => {
  const forbidden = event.index.entries.filter((e) => /\.(env|pem|key)$/.test(e.path));
  if (forbidden.length) {
    return { abort: true, message: `Blocked: ${forbidden.map((e) => e.path).join(", ")}` };
  }
});

// Enforce conventional commit messages
git.on("commit-msg", (event) => {
  if (!/^(feat|fix|docs|refactor|test|chore)(\(.+\))?:/.test(event.message)) {
    return { abort: true, message: "Commit message must follow conventional commits format" };
  }
});
```

| Hook               | Payload                                                         |
| ------------------ | --------------------------------------------------------------- |
| `pre-commit`       | `{ index, treeHash }`                                           |
| `commit-msg`       | `{ message }` (mutable)                                         |
| `merge-msg`        | `{ message, treeHash, headHash, theirsHash }` (mutable message) |
| `pre-merge-commit` | `{ mergeMessage, treeHash, headHash, theirsHash }`              |
| `pre-checkout`     | `{ target, mode }`                                              |
| `pre-push`         | `{ remote, url, refs[] }`                                       |
| `pre-fetch`        | `{ remote, url, refspecs, prune, tags }`                        |
| `pre-clone`        | `{ repository, targetPath, bare, branch }`                      |
| `pre-pull`         | `{ remote, branch }`                                            |
| `pre-rebase`       | `{ upstream, branch }`                                          |
| `pre-reset`        | `{ mode, target }`                                              |
| `pre-clean`        | `{ dryRun, force, removeDirs, removeIgnored, onlyIgnored }`     |
| `pre-rm`           | `{ paths, cached, recursive, force }`                           |
| `pre-cherry-pick`  | `{ mode, commit }`                                              |
| `pre-revert`       | `{ mode, commit }`                                              |
| `pre-stash`        | `{ action, ref }`                                               |

### Post-hooks

Post-hooks are observational -- return value is ignored. Handlers are awaited in registration order.

```ts
// Feed agent activity to your UI or orchestration layer
git.on("post-commit", (event) => {
  onAgentCommit({ hash: event.hash, branch: event.branch, message: event.message });
});

git.on("post-push", (event) => {
  onAgentPush({ remote: event.remote, refs: event.refs });
});
```

| Hook               | Payload                                          |
| ------------------ | ------------------------------------------------ |
| `post-commit`      | `{ hash, message, branch, parents, author }`     |
| `post-merge`       | `{ headHash, theirsHash, strategy, commitHash }` |
| `post-checkout`    | `{ prevHead, newHead, isBranchCheckout }`        |
| `post-push`        | same payload as `pre-push`                       |
| `post-fetch`       | `{ remote, url, refsUpdated }`                   |
| `post-clone`       | `{ repository, targetPath, bare, branch }`       |
| `post-pull`        | `{ remote, branch, strategy, commitHash }`       |
| `post-reset`       | `{ mode, targetHash }`                           |
| `post-clean`       | `{ removed, dryRun }`                            |
| `post-rm`          | `{ removedPaths, cached }`                       |
| `post-cherry-pick` | `{ mode, commitHash, hadConflicts }`             |
| `post-revert`      | `{ mode, commitHash, hadConflicts }`             |
| `post-stash`       | `{ action, ok }`                                 |

### Low-level events

Fire-and-forget events emitted on every object/ref write. Handler errors are caught and forwarded to `hooks.onError` (no-op by default).

| Event          | Payload                     |
| -------------- | --------------------------- |
| `ref:update`   | `{ ref, oldHash, newHash }` |
| `ref:delete`   | `{ ref, oldHash }`          |
| `object:write` | `{ type, hash }`            |

## Multi-agent collaboration

Multiple agents can work on clones of the same repository in the same process, each with full VFS isolation. The `resolveRemote` option maps remote URLs to `GitContext` instances on other virtual filesystems, so clone/fetch/push/pull cross VFS boundaries without any network or shared filesystem.

```ts
import { Bash, InMemoryFs } from "just-bash";
import { createGit, findGitDir } from "just-git";

// Origin repo on its own filesystem
const originFs = new InMemoryFs();
const setupBash = new Bash({
  fs: originFs,
  cwd: "/repo",
  customCommands: [
    createGit({ identity: { name: "Setup", email: "setup@example.com", locked: true } }),
  ],
});
await setupBash.exec("git init");
await setupBash.exec("echo 'hello' > README.md");
await setupBash.exec("git add . && git commit -m 'initial'");

const originCtx = await findGitDir(originFs, "/repo");

// Each agent gets its own filesystem + resolveRemote pointing to origin
function createAgent(name: string, email: string) {
  const agentFs = new InMemoryFs();
  const git = createGit({
    identity: { name, email, locked: true },
    resolveRemote: (url) => (url === "/origin" ? originCtx : null),
  });
  return new Bash({ fs: agentFs, cwd: "/repo", customCommands: [git] });
}

const alice = createAgent("Alice", "alice@example.com");
const bob = createAgent("Bob", "bob@example.com");

await alice.exec("git clone /origin /repo", { cwd: "/" });
await bob.exec("git clone /origin /repo", { cwd: "/" });

// Alice and Bob work independently, push to origin, fetch each other's changes
```

Concurrent pushes to the same remote are automatically serialized — if two agents push simultaneously, one succeeds and the other gets a proper non-fast-forward rejection, just like real git.

See [`examples/multi-agent.ts`](examples/multi-agent.ts) for a full working example with a coordinator agent that merges feature branches.

## Command coverage

34 commands implemented. See [CLI.md](CLI.md) for full usage details.

| Command                           | Flags / options                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init [<dir>]`                    | `--bare`, `--initial-branch`                                                                                                                                                   |
| `clone <repo> [<dir>]`            | `--bare`, `-b <branch>`                                                                                                                                                        |
| `blame <file>`                    | `-L <start>,<end>`, `-l`/`--long`, `-e`/`--show-email`, `-s`/`--suppress`, `-p`/`--porcelain`, `--line-porcelain`                                                              |
| `add <paths>`                     | `.`, `--all`/`-A`, `--update`/`-u`, `--force`/`-f`, `-n`/`--dry-run`, glob pathspecs                                                                                           |
| `rm <paths>`                      | `--cached`, `-r`, `-f`, `-n`/`--dry-run`, glob pathspecs                                                                                                                       |
| `mv <src> <dst>`                  | `-f`, `-n`/`--dry-run`, `-k`                                                                                                                                                   |
| `commit`                          | `-m`, `-F <file>` / `-F -`, `--allow-empty`, `--amend`, `--no-edit`, `-a`                                                                                                      |
| `status`                          | `-s`/`--short`, `--porcelain`, `-b`/`--branch`                                                                                                                                 |
| `log`                             | `--oneline`, `-n`, `--all`, `--reverse`, `--decorate`, `--format`/`--pretty`, `A..B`, `A...B`, `-- <path>`, `--author=`, `--grep=`, `--since`/`--after`, `--until`/`--before`  |
| `show [<object>]`                 | Commits (with diff), annotated tags, trees, blobs                                                                                                                              |
| `diff`                            | `--cached`/`--staged`, `<commit>`, `<commit> <commit>`, `A..B`, `A...B`, `-- <path>`, `--stat`, `--shortstat`, `--numstat`, `--name-only`, `--name-status`                     |
| `branch`                          | `-d`, `-D`, `-m`, `-M`, `-r`, `-a`/`--all`, `-v`/`-vv`, `-u`/`--set-upstream-to`                                                                                               |
| `tag [<name>] [<commit>]`         | `-a -m` (annotated), `-d`, `-l <pattern>`, `-f`                                                                                                                                |
| `switch`                          | `-c`/`-C` (create/force-create), `--detach`/`-d`, `--orphan`, `-` (previous branch), `--guess`/`--no-guess`                                                                    |
| `restore`                         | `-s`/`--source`, `-S`/`--staged`, `-W`/`--worktree`, `-S -W` (both), `--ours`/`--theirs`, pathspec globs                                                                       |
| `checkout`                        | `-b`, `-B`, `--orphan`, detached HEAD, `-- <paths>`, `--ours`/`--theirs`, pathspec globs                                                                                       |
| `reset [<commit>]`                | `-- <paths>`, `--soft`, `--mixed`, `--hard`, pathspec globs                                                                                                                    |
| `merge <branch>`                  | `--no-ff`, `--ff-only`, `--squash`, `-m`, `--abort`, `--continue`, conflict markers                                                                                            |
| `revert <commit>`                 | `--abort`, `--continue`, `-n`/`--no-commit`, `--no-edit`, `-m`/`--mainline`                                                                                                    |
| `cherry-pick <commit>`            | `--abort`, `--continue`, `--skip`, `-x`, `-m`/`--mainline`, `-n`/`--no-commit`, preserves original author                                                                      |
| `rebase <upstream>`               | `--onto <newbase>`, `--abort`, `--continue`, `--skip`                                                                                                                          |
| `stash`                           | `push`, `pop`, `apply`, `list`, `drop`, `show`, `clear`, `-m`, `-u`/`--include-untracked`, `stash@{N}`                                                                         |
| `remote`                          | `add`, `remove`/`rm`, `rename`, `set-url`, `get-url`, `-v`                                                                                                                     |
| `config`                          | `get`, `set`, `unset`, `list`, `--list`/`-l`, `--unset`                                                                                                                        |
| `fetch [<remote>] [<refspec>...]` | `--all`, `--tags`, `--prune`/`-p`                                                                                                                                              |
| `push [<remote>] [<refspec>...]`  | `--force`/`-f`, `-u`/`--set-upstream`, `--all`, `--tags`, `--delete`/`-d`                                                                                                      |
| `pull [<remote>] [<branch>]`      | `--ff-only`, `--no-ff`, `--rebase`/`-r`, `--no-rebase`                                                                                                                         |
| `bisect`                          | `start`, `bad`/`good`/`new`/`old`, `skip`, `reset`, `log`, `replay`, `run`, `terms`, `visualize`/`view`, `--term-new`/`--term-old`, `--no-checkout`, `--first-parent`          |
| `clean`                           | `-f`, `-n`/`--dry-run`, `-d`, `-x`, `-X`, `-e`/`--exclude`                                                                                                                     |
| `reflog`                          | `show [<ref>]`, `exists`, `-n`/`--max-count`                                                                                                                                   |
| `gc`                              | `--aggressive`                                                                                                                                                                 |
| `repack`                          | `-a`/`--all`, `-d`/`--delete`                                                                                                                                                  |
| `rev-parse`                       | `--verify`, `--short`, `--abbrev-ref`, `--symbolic-full-name`, `--show-toplevel`, `--git-dir`, `--is-inside-work-tree`, `--is-bare-repository`, `--show-prefix`, `--show-cdup` |
| `ls-files`                        | `-c`/`--cached`, `-m`/`--modified`, `-d`/`--deleted`, `-o`/`--others`, `-u`/`--unmerged`, `-s`/`--stage`, `--exclude-standard`, `-z`, `-t`                                     |

### Transport

- **Local paths** -- direct filesystem transfer between repositories.
- **Smart HTTP** -- clone, fetch, and push against real Git servers (e.g. GitHub) via Git Smart HTTP protocol. Auth via `credentials` option or `GIT_HTTP_BEARER_TOKEN` / `GIT_HTTP_USER` + `GIT_HTTP_PASSWORD` env vars.

### Internals

- `.gitignore` support (hierarchical, negation, `info/exclude`, `core.excludesFile`)
- Merge-ort strategy with rename detection and recursive merge bases
- Reflog for HEAD, branches, and tracking refs
- Index in Git binary v2 format
- Object storage in real Git format (SHA-1 addressed)
- Packfiles with zlib compression for storage and transport
- Pathspec globs across `add`, `rm`, `diff`, `reset`, `checkout`, `restore`, `log`

## Goals and testing

High fidelity to real git (2.53.0) state and output. Tested using real git as an [oracle](test/oracle/README.md) — hundreds of randomized traces totaling hundreds of thousands of git operations, each verified step-by-step against real git's state and output.

When backed by a real filesystem (e.g. `just-bash` `ReadWriteFs`), interoperable with real git on the same repo, though less extensively tested than behavioral correctness.

## Disclaimer

This project is not affiliated with [just-bash](https://github.com/vercel-labs/just-bash) or Vercel.
