# Hooks reference

Full reference for `just-git` hooks and event types. See the [README](../README.md) for a quick introduction and [CLIENT.md](CLIENT.md) for detailed usage examples.

## GitHooks interface

All hooks are specified as named callback properties on a `GitHooks` config object, passed at construction time via `createGit({ hooks: { ... } })`. All event payloads include `repo: GitRepo`, giving hooks access to the [repo module helpers](REPO.md) for inspecting repository state.

## Rejection protocol

Pre-hooks can reject operations by returning `{ reject: true, message?: string }` (the `Rejection` type). Use `isRejection(value)` as a type guard.

## Composing hooks

Use `composeGitHooks(...hookSets)` to combine multiple `GitHooks` objects:

- **Pre-hooks**: chain in order, short-circuit on first `Rejection`
- **Post-hooks**: chain in order, individually try/caught
- **Low-level events**: chain in order, individually try/caught
- **Mutable message hooks** (`commitMsg`, `mergeMsg`): chain, passing the mutated message through

```ts
import { createGit, composeGitHooks } from "just-git";

const git = createGit({
  hooks: composeGitHooks(auditHooks, policyHooks, loggingHooks),
});
```

## Pre-hooks

Pre-hooks can reject the operation by returning `{ reject: true, message?: string }`.

| Hook             | Payload                                                           | Type                  |
| ---------------- | ----------------------------------------------------------------- | --------------------- |
| `preCommit`      | `{ repo, index, treeHash }`                                       | `PreCommitEvent`      |
| `commitMsg`      | `{ repo, message }` (mutable message)                             | `CommitMsgEvent`      |
| `mergeMsg`       | `{ repo, message, treeHash, headHash, theirsHash }` (mutable msg) | `MergeMsgEvent`       |
| `preMergeCommit` | `{ repo, message, treeHash, headHash, theirsHash }`               | `PreMergeCommitEvent` |
| `preCheckout`    | `{ repo, target, mode }`                                          | `PreCheckoutEvent`    |
| `prePush`        | `{ repo, remote, url, refs[] }`                                   | `PrePushEvent`        |
| `preFetch`       | `{ repo, remote, url, refspecs, prune, tags }`                    | `PreFetchEvent`       |
| `preClone`       | `{ repo?, repository, targetPath, bare, branch }`                 | `PreCloneEvent`       |
| `prePull`        | `{ repo, remote, branch }`                                        | `PrePullEvent`        |
| `preRebase`      | `{ repo, upstream, branch }`                                      | `PreRebaseEvent`      |
| `preReset`       | `{ repo, mode, targetRef }`                                       | `PreResetEvent`       |
| `preCherryPick`  | `{ repo, mode, commitRef }`                                       | `PreCherryPickEvent`  |
| `preRevert`      | `{ repo, mode, commitRef }`                                       | `PreRevertEvent`      |

## Post-hooks

Post-hooks are observational — return value is ignored.

| Hook             | Payload                                                                                                                       | Type                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `postCommit`     | `{ repo, hash, message, branch, parents, author }`                                                                            | `PostCommitEvent`     |
| `postMerge`      | `{ repo, headHash, theirsHash, strategy, commitHash }`. `strategy`: `"fast-forward"` or `"three-way"`.                        | `PostMergeEvent`      |
| `postCheckout`   | `{ repo, prevHead, newHead, isBranchCheckout }`                                                                               | `PostCheckoutEvent`   |
| `postPush`       | same payload as `prePush`                                                                                                     | `PostPushEvent`       |
| `postFetch`      | `{ repo, remote, url, updatedRefCount }`                                                                                      | `PostFetchEvent`      |
| `postClone`      | `{ repo, repository, targetPath, bare, branch }`                                                                              | `PostCloneEvent`      |
| `postPull`       | `{ repo, remote, branch, strategy, commitHash }`. `strategy`: `"up-to-date"`, `"fast-forward"`, `"three-way"`, or `"rebase"`. | `PostPullEvent`       |
| `postReset`      | `{ repo, mode, targetHash }`                                                                                                  | `PostResetEvent`      |
| `postCherryPick` | `{ repo, mode, commitHash, hadConflicts }`                                                                                    | `PostCherryPickEvent` |
| `postRevert`     | `{ repo, mode, commitHash, hadConflicts }`                                                                                    | `PostRevertEvent`     |

## Low-level events

Synchronous, fire-and-forget events emitted on every object/ref write. Return value is ignored.

| Event           | Payload                           | Type               |
| --------------- | --------------------------------- | ------------------ |
| `onRefUpdate`   | `{ repo, ref, oldHash, newHash }` | `RefUpdateEvent`   |
| `onRefDelete`   | `{ repo, ref, oldHash }`          | `RefDeleteEvent`   |
| `onObjectWrite` | `{ repo, type, hash }`            | `ObjectWriteEvent` |

## Command-level hooks

Command-level hooks fire before/after every `git <subcommand>` invocation.

| Hook            | Payload                           | Can reject? | Type                 |
| --------------- | --------------------------------- | ----------- | -------------------- |
| `beforeCommand` | `{ command, args, fs, cwd, env }` | Yes         | `BeforeCommandEvent` |
| `afterCommand`  | `{ command, args, result }`       | No          | `AfterCommandEvent`  |

All event types are exported from `just-git` for TypeScript consumers.
