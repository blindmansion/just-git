# just-git

[![CI](https://github.com/blindmansion/just-git/actions/workflows/ci.yml/badge.svg)](https://github.com/blindmansion/just-git/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/just-git)](https://www.npmjs.com/package/just-git)
[![client size](https://img.shields.io/bundlejs/size/just-git?label=client)](https://bundlejs.com/?q=just-git)
[![server size](https://img.shields.io/bundlejs/size/just-git/server?label=server)](https://bundlejs.com/?q=just-git/server)

Pure TypeScript git implementation. Zero dependencies. 36 commands. Works in Node, Bun, Deno, Cloudflare Workers, and the browser. [Tested against real git](docs/TESTING.md) across millions of randomized operations.

The Git CLI, Git servers, and CI workflows are no longer just things you use to develop apps: they can be part of the apps themselves. The goal of this project is to make that practical.

- **[Virtual filesystem client](docs/CLIENT.md)** for sandboxed environments. Pairs with [just-bash](https://github.com/vercel-labs/just-bash), or use standalone.
- **[Embeddable git server](docs/SERVER.md)** with pluggable storage, auth, and hooks. Supports HTTP, SSH, and in-process transport.
- **[Repo module](docs/REPO.md)** with typed functions for commits, diffs, merges, blame, and bisect that work identically against a virtual filesystem or a database.

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

Pass a `Git` instance into [just-bash](https://github.com/vercel-labs/just-bash) as a custom command and you get pipes, redirects, `&&` chaining, and the full shell environment alongside git. For standalone use without just-bash, `MemoryFileSystem` provides a minimal in-memory filesystem and `git.exec` accepts a single git command string (no shell features):

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

Use `git.findRepo()` to get a `GitContext` for programmatic access via the [repo module](docs/REPO.md). It threads through all operator extensions (hooks, identity, credentials, config overrides) automatically:

```ts
const repo = await git.findRepo();
if (repo) {
  const diff = await diffCommits(repo, parentHash, headHash);
}
```

`createGit` also supports:

- [Command restrictions, network policies, and config overrides](docs/CLIENT.md#options) for sandboxing
- [Lifecycle hooks](docs/CLIENT.md#hooks) from pre-commit secret scanning to push gating
- [Custom merge drivers](docs/CLIENT.md#merge-driver) for programmatic conflict resolution
- [Cross-VFS remote resolution](docs/CLIENT.md#multi-agent-collaboration) for multi-agent collaboration

See [CLIENT.md](docs/CLIENT.md) for the full reference.

### Server

Stand up a git server in two lines. Storage defaults to in-memory; swap in SQLite, PostgreSQL, [Cloudflare Durable Objects](docs/SERVER.md#durableobjectsqlitestorage), or your own backend for persistence:

```ts
import { createServer } from "just-git/server";

const server = createServer({ autoCreate: true });
Bun.serve({ fetch: server.fetch });
// git push http://localhost:3000/my-repo main ← repo created on first push
```

Add branch protection, auth, push hooks, programmatic commits, forks, and GC:

```ts
import { createServer, BunSqliteStorage } from "just-git/server";
import { getChangedFiles } from "just-git/repo";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteStorage(new Database("repos.sqlite")),
  autoCreate: true,
  policy: { protectedBranches: ["main"] },
  hooks: {
    preReceive: ({ auth }) => {
      if (!auth.request?.headers.has("Authorization"))
        return { reject: true, message: "unauthorized" };
    },
    postReceive: async ({ repo, repoId, updates }) => {
      for (const u of updates) {
        const files = await getChangedFiles(repo, u.oldHash, u.newHash);
        console.log(`${repoId}: ${u.ref} — ${files.length} files changed`);
      }
    },
  },
});

// Commit files to a branch server-side (safe against concurrent writes)
await server.commit("my-repo", {
  files: { "README.md": "# Hello\n" },
  message: "initial commit",
  author: { name: "Bot", email: "bot@example.com" },
  branch: "main",
});

// Fork a repo, shares the parent's object pool
await server.forkRepo("my-repo", "user/fork");

// Garbage-collect unreachable objects
await server.gc("my-repo");

Bun.serve({ fetch: server.fetch });
```

- Web-standard `Request`/`Response` — works with Bun, Hono, Cloudflare Workers, Durable Objects, or any fetch-compatible runtime
- Node.js support via `server.nodeHandler` with `http.createServer` and `BetterSqlite3Storage`
- [SSH](docs/SERVER.md#ssh) via `server.handleSession`
- [`Storage` interface](docs/SERVER.md#custom-storage) small enough to plug in any datastore

See [SERVER.md](docs/SERVER.md) for the full API.

## Repo module

`just-git/repo` provides programmatic access to git repositories: reading commits, diffing trees, creating objects, and merging, all without going through command execution.

Everything operates on `GitRepo`, a minimal `{ objectStore, refStore }` interface shared by the client and server. A `GitRepo` can be backed by a virtual filesystem, SQLite, Postgres, or any custom storage. The same helpers work inside both client-side hooks and server-side hooks, and `createWorktree` lets you spin up a full git client against a database-backed repo.

```ts
import { commit, readFileAtCommit, getChangedFiles, mergeTrees, bisect } from "just-git/repo";

// Commit files to a branch — handles blobs, trees, parents, and refs
await commit(repo, {
  files: { "README.md": "# Hello\n", "src/index.ts": "export {};\n" },
  message: "initial commit\n",
  author: { name: "Alice", email: "alice@example.com" },
  branch: "main",
});

const content = await readFileAtCommit(repo, commitHash, "src/index.ts");
const changes = await getChangedFiles(repo, parentHash, commitHash);
const merge = await mergeTrees(repo, oursCommit, theirsCommit);

// Programmatic bisect — binary-search the commit graph with a test callback
const result = await bisect(repo, {
  bad: "main",
  good: "v1.0.0",
  test: async (hash, tree) => {
    const config = await tree.readFile("src/config.ts");
    return config !== null && !config.includes("broken_call");
  },
});
```

See [REPO.md](docs/REPO.md) for the full API, the `GitRepo` interface, and the hybrid worktree pattern.

## Commands

36 commands: `init`, `clone`, `fetch`, `push`, `pull`, `add`, `rm`, `mv`, `commit`, `status`, `log`, `show`, `diff`, `grep`, `blame`, `describe`, `branch`, `tag`, `checkout`, `switch`, `restore`, `reset`, `merge`, `rebase`, `cherry-pick`, `revert`, `stash`, `remote`, `config`, `bisect`, `clean`, `reflog`, `gc`, `repack`, `rev-parse`, `ls-files`. Each implements a subset of real git's flags; see [CLI.md](docs/CLI.md) for details.

### Transport

- **Local paths**: direct filesystem transfer between repositories.
- **Cross-VFS**: clone, fetch, and push between isolated in-memory filesystems via `resolveRemote`. See [CLIENT.md](docs/CLIENT.md#multi-agent-collaboration).
- **Smart HTTP**: clone, fetch, and push against real Git servers (e.g. GitHub) via Git Smart HTTP protocol. Auth via `credentials` option or `GIT_HTTP_BEARER_TOKEN` / `GIT_HTTP_USER` + `GIT_HTTP_PASSWORD` env vars.
- **In-process server**: connect a git client to a `GitServer` without any network stack via `server.asNetwork()`. All server hooks, auth, and policy enforcement work identically to real HTTP. See [CLIENT.md](docs/CLIENT.md#in-process-server).

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
