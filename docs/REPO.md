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

**From a server**: `createServer` returns a server with `repo(id)` to get a `GitRepo` backed by the storage driver:

```ts
import { createServer, BunSqliteStorage } from "just-git/server";
import { Database } from "bun:sqlite";

const server = createServer({
  storage: new BunSqliteStorage(new Database("repos.sqlite")),
});
await server.createRepo("my-repo");
const repo = await server.repo("my-repo"); // GitRepo | null

// Or throw if the repo must exist:
const repo2 = await server.requireRepo("my-repo"); // GitRepo (throws if missing)
```

**Bridging the two**: `createWorktree` materializes a storage-backed repo onto a VFS, enabling full git command execution against a database backend:

```ts
import { createWorktree } from "just-git/repo";
import { createGit } from "just-git";
import { Bash, InMemoryFs } from "just-bash";

const repo = await server.requireRepo("my-repo");
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

const ro = readonlyRepo(repo);
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
const server = createServer({
  storage: new BunSqliteStorage(db),
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
| `readTree`         | `(repo, treeHash) → TreeEntry[]`                        | Read a tree's direct children (name, hash, mode). Round-trips with `writeTree`                                                  |
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

| Function             | Signature                            | Description                                                                                                    |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `commit`             | `(repo, options) → string`           | Commit files to a branch in one call. Handles blobs, tree construction, parent resolution, and ref advancement |
| `writeBlob`          | `(repo, content) → string`           | Write a UTF-8 string as a blob, returns hash                                                                   |
| `writeTree`          | `(repo, entries) → string`           | Build and write a tree from `TreeEntryInput[]` (single-level names)                                            |
| `updateTree`         | `(repo, treeHash, updates) → string` | Apply path-based additions/deletions to a tree, handling nested subtrees. Prunes empty subtrees                |
| `createCommit`       | `(repo, options) → string`           | Create a commit object from a tree hash and explicit parents. Low-level primitive behind `commit`              |
| `createAnnotatedTag` | `(repo, options) → string`           | Create an annotated tag object and ref. Takes `target`, `name`, `tagger`, `message`, optional `targetType`     |

`commit` is the main entry point for programmatic writes — pass files and a branch, everything else is handled:

```ts
import { commit } from "just-git/repo";

await commit(repo, {
  files: { "README.md": "# Hello\n", "src/index.ts": "export {};\n" },
  message: "initial commit\n",
  author: { name: "Alice", email: "alice@example.com" },
  branch: "main",
});

// Subsequent commits auto-resolve the parent and preserve existing files
await commit(repo, {
  files: { "docs/guide.md": "# Guide\n", "src/old.ts": null }, // null deletes
  message: "add docs, remove old file\n",
  author: { name: "Alice", email: "alice@example.com" },
  branch: "main",
});
```

For lower-level control, `readTree`/`writeTree` operate at the single-level tree node level, `updateTree` handles full paths, and `createCommit` takes explicit tree hashes and parents:

```ts
import { readCommit, readTree, writeBlob, writeTree, updateTree } from "just-git/repo";

// Read root entries, modify, write back
const c = await readCommit(repo, headHash);
const entries = await readTree(repo, c.tree);
const blob = await writeBlob(repo, "new content\n");
entries.push({ name: "file.txt", hash: blob, mode: "100644" });
const newTree = await writeTree(repo, entries);

// Or: add/remove files by path (handles nested trees)
const updated = await updateTree(repo, c.tree, [
  { path: "src/lib/new.ts", hash: blob },
  { path: "old-file.txt", hash: null },
]);
```

### Merging

| Function                   | Signature                                                            | Description                                                                                  |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `mergeTrees`               | `(repo, oursCommit, theirsCommit, labels?) → MergeTreesResult`       | Three-way merge using merge-ort. Finds merge bases automatically, handles criss-cross merges |
| `mergeTreesFromTreeHashes` | `(repo, baseTree, oursTree, theirsTree, labels?) → MergeTreesResult` | Three-way merge from raw tree hashes when you already have the base                          |

Both return `{ treeHash, clean, conflicts, messages }`. Operates purely on the object store, with no filesystem or worktree needed.

### Worktree

| Function                | Signature                                               | Description                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extractTree`           | `(repo, refOrHash, fs, targetDir?) → ExtractTreeResult` | Extract a commit's tree onto a filesystem. No `.git` directory is created, just the working tree files                                                             |
| `createWorktree`        | `(repo, fs, options?) → WorktreeResult`                 | Create a full `GitContext` backed by the repo's stores. Populates worktree, index, and `.git` on the VFS. See [GitRepo > Bridging the two](#how-you-get-a-gitrepo) |
| `createSandboxWorktree` | `(repo, options?) → WorktreeResult`                     | Create an isolated worktree with copy-on-write overlay stores and lazy reads. Source repo is never mutated. Designed for server hooks                              |

### Operations

| Function | Signature                          | Description                                                                                                                                              |
| -------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bisect` | `(repo, options) → BisectSearchResult` | Binary-search the commit graph to find the first bad commit. Operates purely on the object store — the caller provides a `test` callback per candidate |

`bisect` uses the same weighted-midpoint algorithm as `git bisect`: each step picks the commit that maximizes information gain. The `test` callback receives the candidate hash and a `TreeAccessor` for lazy file access:

```ts
import { bisect } from "just-git/repo";

const result = await bisect(repo, {
  bad: "main",
  good: "v1.0.0",
  test: async (hash, tree) => {
    const content = await tree.readFile("src/config.ts");
    return content !== null && !content.includes("broken_call");
  },
});

if (result.found) {
  console.log(`First bad commit: ${result.hash} (${result.stepsTaken} steps)`);
}
```

**`BisectOptions`:**

- `bad` — known bad commit (hash, branch, tag, or any rev-parse expression)
- `good` — one or more known good commits (`string | string[]`)
- `test` — `(hash, tree) => boolean | "skip" | Promise<...>`. Return `true` (good), `false` (bad), or `"skip"` (untestable)
- `firstParent?` — follow only first parent at merge commits (default `false`)
- `onStep?` — `(info: BisectStepInfo) => void` for progress reporting

**`BisectSearchResult`** (discriminated union):

- `{ found: true, hash, stepsTaken }` — first bad commit identified
- `{ found: false, reason: "all-skipped", candidates }` — only skipped commits remain
- `{ found: false, reason: "no-testable-commits" }` — no commits between good and bad

### Tree accessor

`TreeAccessor` provides progressively richer access to a git tree's contents without requiring upfront materialization:

| Method          | Signature                                         | Description                                                                    |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `readFile`      | `(path) → string \| null`                         | Read a single file (O(tree depth), no flatten)                                 |
| `readFileBytes` | `(path) → Uint8Array \| null`                     | Read a file's raw bytes                                                        |
| `files`         | `() → string[]`                                   | List all tracked file paths (walks tree objects, no blob reads)                |
| `fs`            | `(root?) → FileSystem`                            | Get a full `FileSystem` view (lazy reads, in-memory writes). Cached per root  |
| `materialize`   | `(target, targetDir?) → number`                   | Write all tracked files onto a `MaterializeTarget`. Returns files written     |
| `treeHash`      | `string`                                          | The underlying git tree object hash                                            |

```ts
import { createTreeAccessor } from "just-git/repo";

const accessor = createTreeAccessor(repo, commit.tree);

// Single file read — no flatten needed
const content = await accessor.readFile("src/index.ts");

// Full filesystem for build/test scenarios
const fs = accessor.fs();
await fs.readFile("package.json");
```

`MaterializeTarget` is the minimal filesystem interface needed by `materialize`: just `writeFile`, `mkdir`, and optionally `symlink`.

### Safety

| Function       | Signature          | Description                                                                                                      |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `readonlyRepo` | `(repo) → GitRepo` | Wrap a repo so all write operations throw. Read operations pass through                                          |
| `overlayRepo`  | `(repo) → GitRepo` | Wrap a repo with copy-on-write overlay stores. Writes go to an in-memory layer; the underlying repo is untouched |

## Storage implementations

The repo module also re-exports `PackedObjectStore` and `FileSystemRefStore`, the `ObjectStore` and `RefStore` implementations used by VFS-backed repositories. These are what `findRepo` uses internally, and can be used directly for custom storage setups.

Server storage drivers (`BunSqliteStorage`, `BetterSqlite3Storage`, `PgStorage`, `MemoryStorage`) provide their own implementations. See [SERVER.md](SERVER.md#storage-drivers) for details.
