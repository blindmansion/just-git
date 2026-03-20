# Repo module

`just-git/repo` provides a programmatic API for working with git repositories: reading commits, diffing trees, creating objects, and merging, all without going through command execution.

```ts
import { readCommit, readFileAtCommit, getChangedFiles, blame, mergeTrees } from "just-git/repo";
```

For command-execution configuration, see [CLIENT.md](CLIENT.md). For the embeddable server, see [SERVER.md](SERVER.md).

## GitRepo

Everything in this module operates on `GitRepo`, a minimal interface representing a git repository as an object store and a ref store:

```ts
interface GitRepo {
  objectStore: ObjectStore;
  refStore: RefStore;
}
```

This is the type that unifies the client and server sides of just-git. Any function that accepts `GitRepo` works identically regardless of what's behind it: an in-memory VFS, a SQLite database, Postgres, or a custom implementation.

### How you get a GitRepo

**From a virtual filesystem**: `findRepo` walks up from a path looking for a `.git` directory and returns a `GitContext` (which extends `GitRepo` with filesystem access, paths, and credentials):

```ts
import { findRepo } from "just-git";

const ctx = await findRepo(fs, "/repo"); // GitContext | null
```

**From a storage backend**: server storage modules return a bare `GitRepo` backed by the database:

```ts
import { BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const storage = new BunSqliteStorage(new Database("repos.sqlite"));
const repo = storage.repo("my-repo"); // GitRepo
```

**Bridging the two**: `createWorktree` materializes a storage-backed repo onto a VFS, enabling full git command execution against a database backend:

```ts
import { createWorktree } from "just-git/repo";
import { createGit } from "just-git";
import { Bash, InMemoryFs } from "just-bash";

const repo = storage.repo("my-repo");
const fs = new InMemoryFs();
await createWorktree(repo, fs, { workTree: "/repo" });

const git = createGit({
  objectStore: repo.objectStore,
  refStore: repo.refStore,
});
const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

// Full git commands, but objects and refs go to SQLite
await bash.exec("echo 'hello' > file.txt");
await bash.exec("git add . && git commit -m 'from agent'");
```

The worktree, index, config, and reflog live on the VFS. Objects and refs go through the storage backend. This enables patterns like spinning up a full git client inside a server hook, or running an agent against a database-backed repo without any `.git` directory on disk.

### Read-only access

Wrap any `GitRepo` with `readonlyRepo` to ensure no writes can occur:

```ts
import { readonlyRepo } from "just-git/repo";

const ro = readonlyRepo(storage.repo("my-repo"));
// ro.objectStore.write(...) and ro.refStore.writeRef(...) will throw
```

## Usage in hooks

Both client-side and server-side hooks receive `repo: GitRepo` in their event payloads, so the same helpers work in both contexts:

```ts
import { getChangedFiles, readFileAtCommit } from "just-git/repo";

// Client-side hook
const git = createGit({
  hooks: {
    postCommit: async ({ repo, hash, parents }) => {
      const files = await getChangedFiles(repo, parents[0] ?? null, hash);
      console.log(
        "changed:",
        files.map((f) => f.path),
      );
    },
  },
});

// Server-side hook
const server = createGitServer({
  resolveRepo: (path) => storage.repo(path),
  hooks: {
    postReceive: async ({ repo, updates }) => {
      for (const u of updates) {
        const pkg = await readFileAtCommit(repo, u.newHash, "package.json");
        if (pkg) console.log("has package.json");
      }
    },
  },
});
```

## API reference

All functions accept `GitRepo` as the first argument.

### Reading

| Function           | Signature                                               | Description                                                                                                                     |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `readCommit`       | `(repo, hash) → Commit`                                 | Parse and return a commit object                                                                                                |
| `readBlob`         | `(repo, hash) → Uint8Array`                             | Read a blob as raw bytes                                                                                                        |
| `readBlobText`     | `(repo, hash) → string`                                 | Read a blob as a UTF-8 string                                                                                                   |
| `readFileAtCommit` | `(repo, commitHash, filePath) → string \| null`         | Read a file's content at a specific commit                                                                                      |
| `grep`             | `(repo, commitHash, patterns, opts?) → GrepFileMatch[]` | Search files at a commit for matching lines. Supports regex, fixed strings, globs, `allMatch`, `invert`, `maxCount`, `maxDepth` |
| `resolveRef`       | `(repo, name) → string \| null`                         | Resolve a ref name to a commit hash                                                                                             |
| `listBranches`     | `(repo) → RefEntry[]`                                   | List all branches (`refs/heads/*`)                                                                                              |
| `listTags`         | `(repo) → RefEntry[]`                                   | List all tags (`refs/tags/*`)                                                                                                   |

### Diffing and history

| Function            | Signature                                               | Description                                                                                     |
| ------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `getChangedFiles`   | `(repo, oldHash, newHash) → TreeDiffEntry[]`            | Files changed between two commits                                                               |
| `diffTrees`         | `(repo, treeA, treeB) → TreeDiffEntry[]`                | Diff two tree hashes directly                                                                   |
| `flattenTree`       | `(repo, treeHash) → FlatTreeEntry[]`                    | Flatten a tree to a sorted list of path/hash entries                                            |
| `getNewCommits`     | `(repo, oldHash, newHash) → AsyncGenerator<CommitInfo>` | Walk commits introduced by a ref update                                                         |
| `walkCommitHistory` | `(repo, startHash, opts?) → AsyncGenerator<CommitInfo>` | Walk the commit graph from one or more hashes. Supports `exclude`, `firstParent`                |
| `findMergeBases`    | `(repo, commitA, commitB) → string[]`                   | Find merge base(s) of two commits                                                               |
| `isAncestor`        | `(repo, candidate, descendant) → boolean`               | Check if one commit is an ancestor of another                                                   |
| `countAheadBehind`  | `(repo, localHash, upstreamHash) → { ahead, behind }`   | Count how many commits local is ahead/behind upstream                                           |
| `blame`             | `(repo, commitHash, path, opts?) → BlameEntry[]`        | Line-by-line blame with originating commit, author, and content. Optional `startLine`/`endLine` |

### Writing

| Function       | Signature                  | Description                                                                   |
| -------------- | -------------------------- | ----------------------------------------------------------------------------- |
| `writeBlob`    | `(repo, content) → string` | Write a UTF-8 string as a blob, returns hash                                  |
| `writeTree`    | `(repo, entries) → string` | Build and write a tree from `TreeEntryInput[]`                                |
| `createCommit` | `(repo, options) → string` | Create a commit object. Optionally advances a branch ref via `options.branch` |

### Merging

| Function                   | Signature                                                            | Description                                                                                  |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `mergeTrees`               | `(repo, oursCommit, theirsCommit, labels?) → MergeTreesResult`       | Three-way merge using merge-ort. Finds merge bases automatically, handles criss-cross merges |
| `mergeTreesFromTreeHashes` | `(repo, baseTree, oursTree, theirsTree, labels?) → MergeTreesResult` | Three-way merge from raw tree hashes when you already have the base                          |

Both return `{ treeHash, clean, conflicts, messages }`. Operates purely on the object store, with no filesystem or worktree needed.

### Worktree

| Function         | Signature                                              | Description                                                                                                                                                        |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `checkoutTo`     | `(repo, refOrHash, fs, targetDir?) → CheckoutToResult` | Materialize a commit's worktree onto a filesystem. No `.git` directory is created, just the working tree files                                                     |
| `createWorktree` | `(repo, fs, options?) → WorktreeResult`                | Create a full `GitContext` backed by the repo's stores. Populates worktree, index, and `.git` on the VFS. See [GitRepo > Bridging the two](#how-you-get-a-gitrepo) |

### Safety

| Function       | Signature          | Description                                                             |
| -------------- | ------------------ | ----------------------------------------------------------------------- |
| `readonlyRepo` | `(repo) → GitRepo` | Wrap a repo so all write operations throw. Read operations pass through |

## Storage implementations

The repo module also re-exports `PackedObjectStore` and `FileSystemRefStore`, the `ObjectStore` and `RefStore` implementations used by VFS-backed repositories. These are what `findRepo` uses internally, and can be used directly for custom storage setups.

Server storage backends (`BunSqliteStorage`, `BetterSqlite3Storage`, `PgStorage`, `MemoryStorage`) provide their own implementations. See [SERVER.md](SERVER.md#storage-backends) for details.
