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
import { Bash } from "just-bash";
import { createGit } from "just-git";

const bash = new Bash({
  cwd: "/repo",
  customCommands: [createGit({ identity: { name: "Alice", email: "alice@example.com" } })],
});

await bash.exec("echo 'hello' > README.md");
await bash.exec("git add . && git commit -m 'initial commit'");
```

Pass a `Git` instance into [just-bash](https://github.com/vercel-labs/just-bash) as a custom command and you get pipes, redirects, `&&` chaining, and the full shell environment alongside git. For standalone use without just-bash, `MemoryFileSystem` provides a minimal in-memory filesystem and `git.exec` accepts a command string with basic quote-aware splitting:

```ts
import { createGit, MemoryFileSystem } from "just-git";

const fs = new MemoryFileSystem();
const git = createGit({
  fs,
  cwd: "/repo",
  identity: { name: "Alice", email: "alice@example.com" },
  credentials: (url) => ({ type: "bearer", token: process.env.GITHUB_TOKEN! }),
  hooks: {
    beforeCommand: ({ command }) => {
      if (command === "push") return { reject: true, message: "push requires approval" };
    },
  },
});

await git.exec("git init");
await fs.writeFile("/repo/README.md", "# Hello\n");
await git.exec("git add .");
await git.exec('git commit -m "initial commit"');
```

Both `fs` and `cwd` can be set once in `createGit` and overridden per-call. `cwd` defaults to `"/"`. Set it to the repo root so every `exec` call finds `.git` automatically.

`createGit` also supports [command restrictions, network policies, and config overrides](docs/CLIENT.md#options) for sandboxing, a [lifecycle hooks API](docs/CLIENT.md#hooks) covering pre-commit secret scanning to push gating, and [cross-VFS remote resolution](docs/CLIENT.md#multi-agent-collaboration) for multi-agent collaboration. See [CLIENT.md](docs/CLIENT.md) for the full reference.

### Server

Stand up a git server with built-in storage (SQLite or PostgreSQL), branch protection, auth, and push hooks:

```ts
import { createGitServer, createStandardHooks, BunSqliteStorage } from "just-git/server";
import { getChangedFiles } from "just-git/repo";
import { Database } from "bun:sqlite";

const storage = new BunSqliteStorage(new Database("repos.sqlite"));

const server = createGitServer({
  resolveRepo: (path) => storage.repo(path),
  hooks: createStandardHooks({
    protectedBranches: ["main"],
    authorizePush: (request) => request.headers.has("Authorization"),
    onPush: async ({ repo, repoPath, updates }) => {
      for (const u of updates) {
        const files = await getChangedFiles(repo, u.oldHash, u.newHash);
        console.log(`${repoPath}: ${u.ref} — ${files.length} files changed`);
      }
    },
  }),
});

Bun.serve({ fetch: server.fetch });
// git clone http://localhost:3000/my-repo ← works with real git
```

Uses web-standard `Request`/`Response`. Works with Bun, Hono, Cloudflare Workers, or any fetch-compatible runtime. For Node.js, use `toNodeHandler(server)` with `http.createServer` and `BetterSqlite3Storage` for `better-sqlite3`. Use `withAuth` to gate clone and fetch access as well. See [SERVER.md](docs/SERVER.md) for the full API.

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

Runnable examples in [`examples/`](examples/) — identity, hooks, multi-agent collaboration, Smart HTTP servers, and more. Run any with `bun examples/<file>`.
