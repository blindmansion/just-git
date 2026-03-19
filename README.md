# just-git

[![CI](https://github.com/blindmansion/just-git/actions/workflows/ci.yml/badge.svg)](https://github.com/blindmansion/just-git/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/just-git)](https://www.npmjs.com/package/just-git)
[![bundle size](https://img.shields.io/bundlejs/size/just-git)](https://bundlejs.com/?q=just-git)

Pure TypeScript git implementation. Zero dependencies. 34 commands. Works in Node, Bun, Deno, Cloudflare Workers, and the browser. [Tested against real git](docs/TESTING.md) across more than a million randomized operations.

Two entry points: a **virtual filesystem client** for sandboxed environments (pairs with [just-bash](https://github.com/vercel-labs/just-bash), or use standalone), and an **[embeddable git server](docs/SERVER.md)** that any standard `git` client can clone, fetch, and push to.

## Install

```bash
npm install just-git
```

## Quick start

### Client

```ts
import { createGit, MemoryFileSystem } from "just-git";

const fs = new MemoryFileSystem();
const git = createGit({ identity: { name: "Alice", email: "alice@example.com" } });

await git.exec("git init", { fs, cwd: "/repo" });
await git.exec("git add .", { fs, cwd: "/repo" });
await git.exec('git commit -m "initial commit"', { fs, cwd: "/repo" });
await git.exec("git log --oneline", { fs, cwd: "/repo" });
```

`MemoryFileSystem` is a minimal in-memory filesystem included with just-git. You can also provide your own implementation of the `FileSystem` interface (e.g. wrapping `node:fs/promises`). Tokenization handles single and double quotes. Pass `env` as a plain object when needed (e.g. `GIT_AUTHOR_NAME`).

For a full virtual shell with file I/O, pipes, and scripting, pair with [just-bash](https://github.com/vercel-labs/just-bash):

```ts
import { Bash } from "just-bash";
import { createGit } from "just-git";

const bash = new Bash({
  cwd: "/repo",
  customCommands: [createGit({ identity: { name: "Alice", email: "alice@example.com" } })],
});

await bash.exec("echo 'hello' > README.md");
await bash.exec("git add . && git commit -m 'initial commit'");
```

### Server

Stand up a git server with built-in storage (SQLite or [PostgreSQL](docs/SERVER.md#pgstorage)), branch protection, and push hooks:

```ts
import { createGitServer, SqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const storage = new SqliteStorage(new Database("repos.sqlite"));

const server = createGitServer({
  resolveRepo: (path) => storage.repo(path),
  hooks: {
    preReceive: ({ updates }) => {
      if (updates.some((u) => u.ref === "refs/heads/main" && !u.isFF))
        return { reject: true, message: "no force-push to main" };
    },
    postReceive: ({ repoPath, updates }) => {
      console.log(`${repoPath}: ${updates.length} ref(s) updated`);
    },
  },
});

Bun.serve({ fetch: server.fetch });
// git clone http://localhost:3000/my-repo ← works with real git
```

Uses web-standard `Request`/`Response` — works with Bun, Hono, Cloudflare Workers, or any fetch-compatible runtime. For Node.js, use `toNodeHandler(server)` with `http.createServer` and `wrapBetterSqlite3` for `better-sqlite3`. See [SERVER.md](docs/SERVER.md) for the full API.

## Options

`createGit(options?)` accepts:

| Option          | Description                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`      | Author/committer override. With `locked: true`, always wins over env vars and git config. Without `locked`, acts as a fallback.                                                                                                                            |
| `credentials`   | `(url) => HttpAuth \| null` callback for Smart HTTP transport auth.                                                                                                                                                                                        |
| `disabled`      | `GitCommandName[]` of subcommands to block (e.g. `["push", "rebase"]`).                                                                                                                                                                                    |
| `network`       | `{ allowed?: string[], fetch?: FetchFunction }` to restrict HTTP access and/or provide a custom `fetch`. `allowed` accepts hostnames (`"github.com"`) or URL prefixes (`"https://github.com/myorg/"`). Set to `false` to block all network access.         |
| `config`        | `{ locked?, defaults? }` config overrides. `locked` values always win over `.git/config`; `defaults` supply fallbacks when a key is absent. Keys are dotted config names (e.g. `"push.default"`, `"merge.ff"`). See [Config overrides](#config-overrides). |
| `hooks`         | `GitHooks` config object with named callback properties. See [Hooks](#hooks).                                                                                                                                                                              |
| `resolveRemote` | `(url) => GitRepo \| null` callback for cross-VFS remote resolution. See [Multi-agent collaboration](#multi-agent-collaboration).                                                                                                                          |

```ts
const git = createGit({
  identity: { name: "Agent Bot", email: "bot@company.com", locked: true },
  credentials: async (url) => ({ type: "bearer", token: "ghp_..." }),
  disabled: ["rebase"],
  network: false, // no HTTP access
  config: {
    locked: { "push.default": "nothing" },
    defaults: { "merge.ff": "only" },
  },
});
```

## Hooks

Hooks fire at specific points inside command execution. Specified as a `GitHooks` config object at construction time. All hook event payloads include `repo: GitRepo`, providing access to the [repo module helpers](src/repo/) inside hooks.

Pre-hooks can reject the operation by returning `{ reject: true, message? }`. Post-hooks are observational — return value is ignored.

```ts
import { createGit, type GitHooks } from "just-git";
import { getChangedFiles } from "just-git/repo";

const git = createGit({
  hooks: {
    // Block secrets from being committed
    preCommit: ({ index }) => {
      const forbidden = index.entries.filter((e) => /\.(env|pem|key)$/.test(e.path));
      if (forbidden.length) {
        return { reject: true, message: `Blocked: ${forbidden.map((e) => e.path).join(", ")}` };
      }
    },

    // Enforce conventional commit messages
    commitMsg: (event) => {
      if (!/^(feat|fix|docs|refactor|test|chore)(\(.+\))?:/.test(event.message)) {
        return { reject: true, message: "Commit message must follow conventional commits format" };
      }
    },

    // Feed agent activity to your UI — with changed file list
    postCommit: async ({ repo, hash, branch, parents }) => {
      const files = await getChangedFiles(repo, parents[0] ?? null, hash);
      onAgentCommit({ hash, branch, changedFiles: files });
    },

    // Audit log — record every command
    afterCommand: ({ command, args, result }) => {
      auditLog.push({ command: `git ${command}`, exitCode: result.exitCode });
    },

    // Gate pushes on human approval
    beforeCommand: async ({ command }) => {
      if (command === "push" && !(await getHumanApproval())) {
        return { reject: true, message: "Push blocked — awaiting approval." };
      }
    },
  },
});
```

Use `composeGitHooks()` to combine multiple hook sets:

```ts
import { createGit, composeGitHooks } from "just-git";

const git = createGit({
  hooks: composeGitHooks(auditHooks, policyHooks, loggingHooks),
});
```

Available pre-hooks: `preCommit`, `commitMsg`, `mergeMsg`, `preMergeCommit`, `preCheckout`, `prePush`, `preFetch`, `preClone`, `prePull`, `preRebase`, `preReset`, `preClean`, `preRm`, `preCherryPick`, `preRevert`, `preStash`. Available post-hooks: `postCommit`, `postMerge`, `postCheckout`, `postPush`, `postFetch`, `postClone`, `postPull`, `postReset`, `postClean`, `postRm`, `postCherryPick`, `postRevert`, `postStash`. Low-level events: `onRefUpdate`, `onRefDelete`, `onObjectWrite`. Command-level: `beforeCommand`, `afterCommand`.

## Config overrides

Control git config values at the operator level, without touching `.git/config`. Works like the `identity` option — `locked` values always win, `defaults` act as fallbacks.

```ts
const git = createGit({
  config: {
    locked: {
      "push.default": "nothing", // agent must always specify a refspec
      "merge.conflictstyle": "diff3", // always show base in conflict markers
    },
    defaults: {
      "pull.rebase": "true", // default to rebase-on-pull (agent can change)
      "merge.ff": "only", // default to ff-only (agent can change)
    },
  },
});
```

- **`locked`** — values that take absolute precedence. The agent can run `git config set` (the write succeeds on the VFS), but the locked value always wins on every read. Useful for enforcing policies.
- **`defaults`** — fallback values when a key is absent from `.git/config`. The agent _can_ override these with `git config set`. Useful for sensible defaults without restricting the agent.

Applied transparently via `getConfigValue()` — all commands respect overrides automatically. Any dotted config key works (e.g. `"merge.ff"`, `"push.default"`, `"pull.rebase"`, `"merge.conflictstyle"`, `"branch.autoSetupMerge"`).

## Repo module

`just-git/repo` provides a high-level API for working with repositories programmatically — reading commits, diffing trees, creating objects, and merging — without going through command execution. This is what you use inside hooks (all hook payloads include `repo: GitRepo`) and anywhere else you need direct repo access.

```ts
import {
  readCommit,
  readFileAtCommit,
  getChangedFiles,
  resolveRef,
  listBranches,
  diffTrees,
  flattenTree,
  createCommit,
  writeBlob,
  writeTree,
  mergeTrees,
  checkoutTo,
  readonlyRepo,
} from "just-git/repo";

// Read a file at a specific commit
const content = await readFileAtCommit(repo, commitHash, "src/index.ts");

// Diff two commits
const changes = await getChangedFiles(repo, parentHash, commitHash);

// Merge two branches at the tree level (no worktree needed)
const result = await mergeTrees(repo, oursCommit, theirsCommit);
if (!result.clean) console.log("conflicts:", result.conflicts);
```

Also re-exports `PackedObjectStore` and `FileSystemRefStore` for custom storage backends, and `readonlyRepo()` to wrap a repo so all write operations throw.

## Multi-agent collaboration

Multiple agents can work on clones of the same repository in the same process, each with full VFS isolation. The `resolveRemote` option maps remote URLs to `GitRepo` instances (any object/ref store — VFS-backed, SQLite, etc.), so clone/fetch/push/pull cross VFS boundaries without any network or shared filesystem.

```ts
import { Bash, InMemoryFs } from "just-bash";
import { createGit, findRepo } from "just-git";

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

const alice = new Bash({
  fs: new InMemoryFs(),
  cwd: "/repo",
  customCommands: [
    createGit({
      identity: { name: "Alice", email: "alice@example.com", locked: true },
      resolveRemote: () => findRepo(originFs, "/repo"),
    }),
  ],
});

const bob = new Bash({
  fs: new InMemoryFs(),
  cwd: "/repo",
  customCommands: [
    createGit({
      identity: { name: "Bob", email: "bob@example.com", locked: true },
      resolveRemote: () => findRepo(originFs, "/repo"),
    }),
  ],
});

await alice.exec("git clone /origin /repo");
await bob.exec("git clone /origin /repo");

// Alice and Bob work independently, push to origin, fetch each other's changes
```

Concurrent pushes to the same remote are automatically serialized — if two agents push simultaneously, one succeeds and the other gets a proper non-fast-forward rejection, just like real git.

See [`examples/multi-agent.ts`](examples/multi-agent.ts) for a full working example with a coordinator agent that merges feature branches.

## Command coverage

See [CLI.md](docs/CLI.md) for full usage details.

| Command                           | Flags / options                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init [<dir>]`                    | `--bare`, `--initial-branch`                                                                                                                                                                                                                                                   |
| `clone <repo> [<dir>]`            | `--bare`, `-b <branch>`                                                                                                                                                                                                                                                        |
| `blame <file>`                    | `-L <start>,<end>`, `-l`/`--long`, `-e`/`--show-email`, `-s`/`--suppress`, `-p`/`--porcelain`, `--line-porcelain`                                                                                                                                                              |
| `add <paths>`                     | `.`, `--all`/`-A`, `--update`/`-u`, `--force`/`-f`, `-n`/`--dry-run`, glob pathspecs                                                                                                                                                                                           |
| `rm <paths>`                      | `--cached`, `-r`, `-f`, `-n`/`--dry-run`, glob pathspecs                                                                                                                                                                                                                       |
| `mv <src> <dst>`                  | `-f`, `-n`/`--dry-run`, `-k`                                                                                                                                                                                                                                                   |
| `commit`                          | `-m`, `-F <file>` / `-F -`, `--allow-empty`, `--amend`, `--no-edit`, `-a`                                                                                                                                                                                                      |
| `status`                          | `-s`/`--short`, `--porcelain`, `-b`/`--branch`                                                                                                                                                                                                                                 |
| `log`                             | `--oneline`, `-n`, `--all`, `--reverse`, `--decorate`, `--graph`, `--format`/`--pretty`, `-p`/`--patch`, `--stat`, `--name-status`, `--name-only`, `--shortstat`, `--numstat`, `A..B`, `A...B`, `-- <path>`, `--author=`, `--grep=`, `--since`/`--after`, `--until`/`--before` |
| `show [<object>]`                 | Commits (with diff), annotated tags, trees, blobs                                                                                                                                                                                                                              |
| `diff`                            | `--cached`/`--staged`, `<commit>`, `<commit> <commit>`, `A..B`, `A...B`, `-- <path>`, `--stat`, `--shortstat`, `--numstat`, `--name-only`, `--name-status`                                                                                                                     |
| `branch`                          | `-d`, `-D`, `-m`, `-M`, `-r`, `-a`/`--all`, `-v`/`-vv`, `-u`/`--set-upstream-to`                                                                                                                                                                                               |
| `tag [<name>] [<commit>]`         | `-a -m` (annotated), `-d`, `-l <pattern>`, `-f`                                                                                                                                                                                                                                |
| `switch`                          | `-c`/`-C` (create/force-create), `--detach`/`-d`, `--orphan`, `-` (previous branch), `--guess`/`--no-guess`                                                                                                                                                                    |
| `restore`                         | `-s`/`--source`, `-S`/`--staged`, `-W`/`--worktree`, `-S -W` (both), `--ours`/`--theirs`, pathspec globs                                                                                                                                                                       |
| `checkout`                        | `-b`, `-B`, `--orphan`, `--detach`/`-d`, detached HEAD, `-- <paths>`, `--ours`/`--theirs`, pathspec globs                                                                                                                                                                      |
| `reset [<commit>]`                | `-- <paths>`, `--soft`, `--mixed`, `--hard`, pathspec globs                                                                                                                                                                                                                    |
| `merge <branch>`                  | `--no-ff`, `--ff-only`, `--squash`, `-m`, `--abort`, `--continue`, conflict markers                                                                                                                                                                                            |
| `revert <commit>`                 | `--abort`, `--continue`, `-n`/`--no-commit`, `--no-edit`, `-m`/`--mainline`                                                                                                                                                                                                    |
| `cherry-pick <commit>`            | `--abort`, `--continue`, `--skip`, `-x`, `-m`/`--mainline`, `-n`/`--no-commit`, preserves original author                                                                                                                                                                      |
| `rebase <upstream>`               | `--onto <newbase>`, `--abort`, `--continue`, `--skip`                                                                                                                                                                                                                          |
| `stash`                           | `push`, `pop`, `apply`, `list`, `drop`, `show`, `clear`, `-m`, `-u`/`--include-untracked`, `stash@{N}`                                                                                                                                                                         |
| `remote`                          | `add`, `remove`/`rm`, `rename`, `set-url`, `get-url`, `-v`                                                                                                                                                                                                                     |
| `config`                          | `get`, `set`, `unset`, `list`, `--list`/`-l`, `--unset`, `--get-all`, `--add`                                                                                                                                                                                                  |
| `fetch [<remote>] [<refspec>...]` | `--all`, `--tags`, `--prune`/`-p`                                                                                                                                                                                                                                              |
| `push [<remote>] [<refspec>...]`  | `--force`/`-f`, `-u`/`--set-upstream`, `--all`, `--tags`, `--delete`/`-d`                                                                                                                                                                                                      |
| `pull [<remote>] [<branch>]`      | `--ff-only`, `--no-ff`, `--rebase`/`-r`, `--no-rebase`                                                                                                                                                                                                                         |
| `bisect`                          | `start`, `bad`/`good`/`new`/`old`, `skip`, `reset`, `log`, `replay`, `run`, `terms`, `visualize`/`view`, `--term-new`/`--term-old`, `--no-checkout`, `--first-parent`                                                                                                          |
| `clean`                           | `-f`, `-n`/`--dry-run`, `-d`, `-x`, `-X`, `-e`/`--exclude`                                                                                                                                                                                                                     |
| `reflog`                          | `show [<ref>]`, `exists`, `-n`/`--max-count`                                                                                                                                                                                                                                   |
| `gc`                              | `--aggressive`                                                                                                                                                                                                                                                                 |
| `repack`                          | `-a`/`--all`, `-d`/`--delete`                                                                                                                                                                                                                                                  |
| `rev-parse`                       | `--verify`, `--short`, `--abbrev-ref`, `--symbolic-full-name`, `--show-toplevel`, `--git-dir`, `--is-inside-work-tree`, `--is-bare-repository`, `--show-prefix`, `--show-cdup`                                                                                                 |
| `ls-files`                        | `-c`/`--cached`, `-m`/`--modified`, `-d`/`--deleted`, `-o`/`--others`, `-u`/`--unmerged`, `-s`/`--stage`, `--exclude-standard`, `-z`, `-t`                                                                                                                                     |

### Transport

- **Local paths** -- direct filesystem transfer between repositories.
- **Cross-VFS** -- clone, fetch, and push between isolated in-memory filesystems via `resolveRemote`. See [Multi-agent collaboration](#multi-agent-collaboration).
- **Smart HTTP** -- clone, fetch, and push against real Git servers (e.g. GitHub) via Git Smart HTTP protocol. Auth via `credentials` option or `GIT_HTTP_BEARER_TOKEN` / `GIT_HTTP_USER` + `GIT_HTTP_PASSWORD` env vars.

### Internals

- `.gitignore` support (hierarchical, negation, `info/exclude`, `core.excludesFile`)
- Merge-ort strategy with rename detection and recursive merge bases
- Reflog for HEAD, branches, and tracking refs
- Index in Git binary v2 format
- Object storage in real Git format (SHA-1 addressed)
- Packfiles with zlib compression for storage and transport
- Pathspec globs across `add`, `rm`, `diff`, `reset`, `checkout`, `restore`, `log`

## Testing

Targets high fidelity to real git (2.53.0). Validated with an [oracle testing framework](test/oracle/README.md) that generates randomized git workflows, runs them against real git, replays each step against just-git, and compares repository state and command output at every step. Run `bun oracle validate` to generate and test a representative set of traces yourself. See [TESTING.md](docs/TESTING.md) for the full methodology and how to interpret results.

When backed by a real filesystem (e.g. just-bash `ReadWriteFs`), interoperable with real git on the same repo. Try `bun sandbox "git init"` to explore interactively.

## Examples

Runnable examples in [`examples/`](examples/):

| File                                                            | What it demonstrates                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`usage.ts`](examples/usage.ts)                                 | Identity, disabled commands, hooks, compose, full sandbox setup      |
| [`multi-agent.ts`](examples/multi-agent.ts)                     | Cross-VFS collaboration with clone/push/pull between isolated agents |
| [`server.ts`](examples/server.ts)                               | VFS-backed Smart HTTP server with virtual client clone and push      |
| [`sqlite-server.ts`](examples/sqlite-server.ts)                 | SQLite-backed server with auto-creating repos, works with real `git` |
| [`node-server.mjs`](examples/node-server.mjs)                   | Node.js HTTP server with SQLite + auth via `better-sqlite3`          |
| [`platform-server.ts`](examples/platform-server.ts)             | GitHub-like PR workflows: create, merge, close via REST API          |
| [`agent-remote-workflow.ts`](examples/agent-remote-workflow.ts) | Clone from GitHub, work in sandbox, push back (requires token)       |

Run any example with `bun examples/<file>`.
