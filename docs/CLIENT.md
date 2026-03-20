# Client

Operator API for configuring git command execution in sandboxed environments. See also [REPO.md](REPO.md) (`just-git/repo`) and [SERVER.md](SERVER.md) (`just-git/server`).

## Options

`createGit(options?)` accepts:

| Option          | Description                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs`            | Default filesystem for `exec()`. Can be overridden per-call.                                                                                                                                                                                       |
| `cwd`           | Default working directory for `exec()`. Defaults to `"/"`. Set to the repo root so every `exec()` call finds `.git` automatically. Can be overridden per-call.                                                                                     |
| `identity`      | Author/committer override. With `locked: true`, always wins over env vars and git config. Without `locked`, acts as a fallback. Visible via `git config user.name` / `user.email`.                                                                 |
| `credentials`   | `(url) => HttpAuth \| null` callback for Smart HTTP transport auth.                                                                                                                                                                                |
| `disabled`      | `GitCommandName[]` of subcommands to block (e.g. `["push", "rebase"]`).                                                                                                                                                                            |
| `network`       | `{ allowed?: string[], fetch?: FetchFunction }` to restrict HTTP access and/or provide a custom `fetch`. `allowed` accepts hostnames (`"github.com"`) or URL prefixes (`"https://github.com/myorg/"`). Set to `false` to block all network access. |
| `config`        | `{ locked?, defaults? }` config overrides. `locked` values always win over `.git/config`; `defaults` supply fallbacks when a key is absent. See [Config overrides](#config-overrides).                                                             |
| `hooks`         | `GitHooks` config object with named callback properties. See [Hooks](#hooks).                                                                                                                                                                      |
| `resolveRemote` | `(url) => GitRepo \| null` callback for cross-VFS remote resolution. See [Multi-agent collaboration](#multi-agent-collaboration).                                                                                                                  |

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

Hooks fire at specific points inside command execution. Specified as a `GitHooks` config object at construction time. All hook event payloads include `repo: GitRepo`, providing access to the [repo module](REPO.md) inside hooks.

Pre-hooks can reject the operation by returning `{ reject: true, message? }`. Post-hooks are observational; the return value is ignored.

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

See [HOOKS.md](HOOKS.md) for the full type reference.

## Config overrides

Control git config values at the operator level, without touching `.git/config`. Works like the `identity` option: `locked` values always win, `defaults` act as fallbacks.

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

- **`locked`**: values that take absolute precedence. The agent can run `git config set` (the write succeeds on the VFS), but the locked value always wins on every read. Useful for enforcing policies.
- **`defaults`**: fallback values when a key is absent from `.git/config`. The agent _can_ override these with `git config set`. Useful for sensible defaults without restricting the agent.

Applied transparently via `getConfigValue()`, so all commands respect overrides automatically. Any dotted config key works (e.g. `"merge.ff"`, `"push.default"`, `"pull.rebase"`, `"merge.conflictstyle"`, `"branch.autoSetupMerge"`).

## Multi-agent collaboration

Multiple agents can work on clones of the same repository in the same process, each with full VFS isolation. The `resolveRemote` option maps remote URLs to `GitRepo` instances (any object/ref store: VFS-backed, SQLite, etc.), so clone/fetch/push/pull cross VFS boundaries without any network or shared filesystem.

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

Concurrent pushes to the same remote are automatically serialized. If two agents push simultaneously, one succeeds and the other gets a proper non-fast-forward rejection, just like real git.

See [`examples/multi-agent.ts`](../examples/multi-agent.ts) for a full working example with a coordinator agent that merges feature branches.

## Transport

Three transport modes for moving objects between repositories:

- **Local paths**: direct filesystem transfer between repositories on the same VFS.
- **Cross-VFS**: clone, fetch, and push between isolated in-memory filesystems via `resolveRemote`. The remote can be any `GitRepo` (VFS-backed, SQLite-backed, or any custom `ObjectStore` + `RefStore`). See [Multi-agent collaboration](#multi-agent-collaboration).
- **Smart HTTP**: clone, fetch, and push against real Git servers (e.g. GitHub) via Git Smart HTTP protocol. Auth via `credentials` option or `GIT_HTTP_BEARER_TOKEN` / `GIT_HTTP_USER` + `GIT_HTTP_PASSWORD` env vars. Restrict access with the `network` option.
