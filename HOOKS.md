# Hooks and middleware reference

Full reference for `just-git` hooks, middleware, and low-level events. See the [README](README.md) for usage examples.

## Middleware

Middleware wraps every `git <subcommand>` invocation. Register with `git.use(fn)`, which returns an unsubscribe function. Middlewares compose in registration order (first registered = outermost).

Each middleware receives a `CommandEvent` and a `next()` function. Call `next()` to proceed, or return an `ExecResult` to short-circuit.

### `CommandEvent`

```ts
interface CommandEvent {
  command: string; // subcommand name ("commit", "push", etc.)
  rawArgs: string[]; // arguments after the subcommand
  fs: FileSystem; // virtual filesystem
  cwd: string; // current working directory
  env: Map<string, string>;
  stdin: string;
  exec?: (cmd: string) => Promise<ExecResult>;
  signal?: AbortSignal;
}
```

### `ExecResult`

```ts
interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

## Hooks

Register with `git.on(event, handler)`, which returns an unsubscribe function. Hooks fire at specific points inside command execution, after middleware.

### Pre-hooks

Pre-hooks can abort the operation by returning `{ abort: true, message?: string }`.

| Hook               | Payload                                                         | Type                  |
| ------------------ | --------------------------------------------------------------- | --------------------- |
| `pre-commit`       | `{ index, treeHash }`                                           | `PreCommitEvent`      |
| `commit-msg`       | `{ message }` (mutable)                                         | `CommitMsgEvent`      |
| `merge-msg`        | `{ message, treeHash, headHash, theirsHash }` (mutable message) | `MergeMsgEvent`       |
| `pre-merge-commit` | `{ mergeMessage, treeHash, headHash, theirsHash }`              | `PreMergeCommitEvent` |
| `pre-checkout`     | `{ target, mode }`                                              | `PreCheckoutEvent`    |
| `pre-push`         | `{ remote, url, refs[] }`                                       | `PrePushEvent`        |
| `pre-fetch`        | `{ remote, url, refspecs, prune, tags }`                        | `PreFetchEvent`       |
| `pre-clone`        | `{ repository, targetPath, bare, branch }`                      | `PreCloneEvent`       |
| `pre-pull`         | `{ remote, branch }`                                            | `PrePullEvent`        |
| `pre-rebase`       | `{ upstream, branch }`                                          | `PreRebaseEvent`      |
| `pre-reset`        | `{ mode, target }`                                              | `PreResetEvent`       |
| `pre-clean`        | `{ dryRun, force, removeDirs, removeIgnored, onlyIgnored }`     | `PreCleanEvent`       |
| `pre-rm`           | `{ paths, cached, recursive, force }`                           | `PreRmEvent`          |
| `pre-cherry-pick`  | `{ mode, commit }`                                              | `PreCherryPickEvent`  |
| `pre-revert`       | `{ mode, commit }`                                              | `PreRevertEvent`      |
| `pre-stash`        | `{ action, ref }`                                               | `PreStashEvent`       |

### Post-hooks

Post-hooks are observational — return value is ignored. Handlers are awaited in registration order.

| Hook               | Payload                                          | Type                  |
| ------------------ | ------------------------------------------------ | --------------------- |
| `post-commit`      | `{ hash, message, branch, parents, author }`     | `PostCommitEvent`     |
| `post-merge`       | `{ headHash, theirsHash, strategy, commitHash }` | `PostMergeEvent`      |
| `post-checkout`    | `{ prevHead, newHead, isBranchCheckout }`        | `PostCheckoutEvent`   |
| `post-push`        | same payload as `pre-push`                       | `PostPushEvent`       |
| `post-fetch`       | `{ remote, url, refsUpdated }`                   | `PostFetchEvent`      |
| `post-clone`       | `{ repository, targetPath, bare, branch }`       | `PostCloneEvent`      |
| `post-pull`        | `{ remote, branch, strategy, commitHash }`       | `PostPullEvent`       |
| `post-reset`       | `{ mode, targetHash }`                           | `PostResetEvent`      |
| `post-clean`       | `{ removed, dryRun }`                            | `PostCleanEvent`      |
| `post-rm`          | `{ removedPaths, cached }`                       | `PostRmEvent`         |
| `post-cherry-pick` | `{ mode, commitHash, hadConflicts }`             | `PostCherryPickEvent` |
| `post-revert`      | `{ mode, commitHash, hadConflicts }`             | `PostRevertEvent`     |
| `post-stash`       | `{ action, ok }`                                 | `PostStashEvent`      |

### Low-level events

Fire-and-forget events emitted on every object/ref write. Handler errors are caught and forwarded to `hooks.onError` (no-op by default). Return value is ignored.

| Event          | Payload                     | Type               |
| -------------- | --------------------------- | ------------------ |
| `ref:update`   | `{ ref, oldHash, newHash }` | `RefUpdateEvent`   |
| `ref:delete`   | `{ ref, oldHash }`          | `RefDeleteEvent`   |
| `object:write` | `{ type, hash }`            | `ObjectWriteEvent` |

All event types are exported from `just-git` for TypeScript consumers.
