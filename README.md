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
const git = createGit({
  identity: { name: "Alice", email: "alice@example.com" },
  credentials: (url) => ({ type: "bearer", token: process.env.GITHUB_TOKEN! }),
  hooks: {
    beforeCommand: ({ command }) => {
      if (command === "push") return { reject: true, message: "push requires approval" };
    },
  },
});

await git.exec("git init", { fs, cwd: "/repo" });
await fs.writeFile("/repo/README.md", "# Hello\n");
await git.exec("git add .", { fs, cwd: "/repo" });
await git.exec('git commit -m "initial commit"', { fs, cwd: "/repo" });
await git.exec("git log --oneline", { fs, cwd: "/repo" });
```

`MemoryFileSystem` is a minimal in-memory filesystem for standalone use. Tokenization handles single and double quotes; pass `env` as a plain object when needed (e.g. `GIT_AUTHOR_NAME`). The `FileSystem` interface is built around [just-bash](https://github.com/vercel-labs/just-bash)'s implementations. For anything beyond bare git commands, it's recommended to use just-git as a custom command in just-bash:

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
import { createGitServer, BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const storage = new BunSqliteStorage(new Database("repos.sqlite"));

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

Uses web-standard `Request`/`Response`. Works with Bun, Hono, Cloudflare Workers, or any fetch-compatible runtime. For Node.js, use `toNodeHandler(server)` with `http.createServer` and `BetterSqlite3Storage` for `better-sqlite3`. See [SERVER.md](docs/SERVER.md) for the full API.

## createGit options

`createGit(options?)` accepts:

| Option          | Description                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`      | Author/committer override. With `locked: true`, always wins over env vars and git config. Without `locked`, acts as a fallback.             |
| `credentials`   | `(url) => HttpAuth \| null` callback for Smart HTTP transport auth.                                                                         |
| `disabled`      | `GitCommandName[]` of subcommands to block (e.g. `["push", "rebase"]`).                                                                     |
| `network`       | `{ allowed?: string[], fetch? }` to restrict HTTP access. Set to `false` to block all network access.                                       |
| `config`        | `{ locked?, defaults? }` config overrides. `locked` values always win over `.git/config`; `defaults` supply fallbacks when a key is absent. |
| `hooks`         | Lifecycle hooks for pre/post command interception, commit gating, message enforcement, and audit logging.                                   |
| `resolveRemote` | `(url) => GitRepo \| null` callback for cross-VFS remote resolution (multi-agent setups).                                                   |

See [CLIENT.md](docs/CLIENT.md) for detailed usage, config overrides, and multi-agent collaboration.

## Client hooks

Hooks fire at specific points inside command execution. Pre-hooks can reject the operation by returning `{ reject: true, message? }`. Post-hooks are observational. All hook payloads include `repo: GitRepo` for [programmatic repo access](docs/REPO.md).

```ts
import { createGit } from "just-git";
import { getChangedFiles } from "just-git/repo";

const git = createGit({
  hooks: {
    preCommit: ({ index }) => {
      const forbidden = index.entries.filter((e) => /\.(env|pem|key)$/.test(e.path));
      if (forbidden.length) {
        return { reject: true, message: `Blocked: ${forbidden.map((e) => e.path).join(", ")}` };
      }
    },
    postCommit: async ({ repo, hash, branch, parents }) => {
      const files = await getChangedFiles(repo, parents[0] ?? null, hash);
      onAgentCommit({ hash, branch, changedFiles: files });
    },
  },
});
```

Combine multiple hook sets with `composeGitHooks(auditHooks, policyHooks, loggingHooks)`. See [HOOKS.md](docs/HOOKS.md) for the full type reference and [CLIENT.md](docs/CLIENT.md) for more examples.

## Repo module

`just-git/repo` provides programmatic access to git repositories: reading commits, diffing trees, creating objects, and merging, all without going through command execution.

Everything operates on `GitRepo`, a minimal `{ objectStore, refStore }` interface shared by the client and server. A `GitRepo` can be backed by a virtual filesystem, SQLite, Postgres, or any custom storage. The same helpers work inside both client-side hooks and server-side hooks, and `createWorktree` lets you spin up a full git client against a database-backed repo.

```ts
import { readFileAtCommit, getChangedFiles, mergeTrees } from "just-git/repo";

const content = await readFileAtCommit(repo, commitHash, "src/index.ts");
const changes = await getChangedFiles(repo, parentHash, commitHash);
const result = await mergeTrees(repo, oursCommit, theirsCommit);
```

See [REPO.md](docs/REPO.md) for the full API, the `GitRepo` interface, and the hybrid worktree pattern.

## Multi-agent collaboration

Multiple agents can clone, fetch, push, and pull across isolated in-memory filesystems within the same process via the `resolveRemote` option, without needing a network or shared filesystem. Concurrent pushes are automatically serialized with proper non-fast-forward rejection. See [CLIENT.md](docs/CLIENT.md#multi-agent-collaboration) and [`examples/multi-agent.ts`](examples/multi-agent.ts).

## Commands

34 commands: `init`, `clone`, `fetch`, `push`, `pull`, `add`, `rm`, `mv`, `commit`, `status`, `log`, `show`, `diff`, `blame`, `branch`, `tag`, `checkout`, `switch`, `restore`, `reset`, `merge`, `rebase`, `cherry-pick`, `revert`, `stash`, `remote`, `config`, `bisect`, `clean`, `reflog`, `gc`, `repack`, `rev-parse`, `ls-files`. See [CLI.md](docs/CLI.md) for full usage details.

### Transport

- **Local paths**: direct filesystem transfer between repositories.
- **Cross-VFS**: clone, fetch, and push between isolated in-memory filesystems via `resolveRemote`. See [CLIENT.md](docs/CLIENT.md#multi-agent-collaboration).
- **Smart HTTP**: clone, fetch, and push against real Git servers (e.g. GitHub) via Git Smart HTTP protocol. Auth via `credentials` option or `GIT_HTTP_BEARER_TOKEN` / `GIT_HTTP_USER` + `GIT_HTTP_PASSWORD` env vars.

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
