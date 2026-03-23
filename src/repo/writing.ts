import { readObject, writeObject } from "../lib/object-db.ts";
import { serializeCommit } from "../lib/objects/commit.ts";
import { parseTree, serializeTree } from "../lib/objects/tree.ts";
import type { GitRepo, Identity, TreeEntry } from "../lib/types.ts";

// ── Commit creation ─────────────────────────────────────────────────

/** Options for {@link createCommit}. */
export interface CreateCommitOptions {
	/** Hash of the tree object for this commit. */
	tree: string;
	/** Parent commit hashes (empty for root commits). */
	parents: string[];
	author: Identity;
	committer: Identity;
	message: string;
	/**
	 * When set, advances `refs/heads/<branch>` to the new commit.
	 * If HEAD does not exist yet, it is created as a symbolic ref
	 * pointing to the branch — matching `git init` + `git commit`.
	 */
	branch?: string;
}

/**
 * Create a commit object directly in the object store.
 * Returns the new commit's hash.
 *
 * When `branch` is provided, also advances the branch ref and
 * (if HEAD is absent) initializes HEAD as a symbolic ref to it.
 * Without `branch`, no refs are updated.
 */
export async function createCommit(repo: GitRepo, options: CreateCommitOptions): Promise<string> {
	const content = serializeCommit({
		type: "commit",
		tree: options.tree,
		parents: options.parents,
		author: options.author,
		committer: options.committer,
		message: options.message,
	});
	const hash = await writeObject(repo, "commit", content);

	if (options.branch) {
		const branchRef = `refs/heads/${options.branch}`;
		await repo.refStore.writeRef(branchRef, { type: "direct", hash });
		const head = await repo.refStore.readRef("HEAD");
		if (!head) {
			await repo.refStore.writeRef("HEAD", { type: "symbolic", target: branchRef });
		}
	}

	return hash;
}

// ── Tree construction ───────────────────────────────────────────────

/** An entry to include in a tree built by {@link writeTree}. */
export interface TreeEntryInput {
	/** Filename (not a path — nesting is achieved by including tree entries). */
	name: string;
	/** Hash of the blob or tree object. */
	hash: string;
	/** File mode (e.g. "100644"). Auto-detected from the object store when omitted. */
	mode?: string;
}

/**
 * Build a tree object from a flat list of entries and write it to the
 * object store. When `mode` is omitted, the object store is consulted:
 * tree objects get "040000", everything else gets "100644".
 */
export async function writeTree(repo: GitRepo, entries: TreeEntryInput[]): Promise<string> {
	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	const resolved = await Promise.all(
		sorted.map(async (e) => {
			let mode = e.mode;
			if (!mode) {
				const obj = await repo.objectStore.read(e.hash);
				mode = obj.type === "tree" ? "040000" : "100644";
			}
			return { mode, name: e.name, hash: e.hash };
		}),
	);
	const content = serializeTree({ type: "tree", entries: resolved });
	return writeObject(repo, "tree", content);
}

/**
 * Write a UTF-8 string as a blob to the object store.
 * Returns the blob's hash.
 */
export async function writeBlob(repo: GitRepo, content: string): Promise<string> {
	return writeObject(repo, "blob", new TextEncoder().encode(content));
}

// ── Tree modification ───────────────────────────────────────────────

/** A file to add or update in a tree via {@link updateTree}. */
export interface TreeUpdate {
	/** Full repo-relative path (e.g. `"src/lib/foo.ts"`). */
	path: string;
	/** Blob hash. When `null`, the file is removed. */
	hash: string | null;
	/** File mode (default `"100644"`). Ignored when `hash` is `null`. */
	mode?: string;
}

/**
 * Apply path-based additions, updates, and deletions to an existing
 * tree, handling nested subtree construction automatically.
 * Returns the new root tree hash.
 *
 * ```ts
 * const blob = await writeBlob(repo, "hello world\n");
 * const newTree = await updateTree(repo, commit.tree, [
 *   { path: "src/new-file.ts", hash: blob },
 *   { path: "old-file.txt", hash: null },
 * ]);
 * ```
 */
export async function updateTree(
	repo: GitRepo,
	treeHash: string,
	updates: TreeUpdate[],
): Promise<string> {
	return applyUpdates(repo, treeHash, groupBySegment(updates));
}

interface SegmentGroup {
	files: Map<string, { hash: string | null; mode: string }>;
	dirs: Map<string, TreeUpdate[]>;
}

function groupBySegment(updates: TreeUpdate[]): SegmentGroup {
	const files = new Map<string, { hash: string | null; mode: string }>();
	const dirs = new Map<string, TreeUpdate[]>();

	for (const u of updates) {
		const slashIdx = u.path.indexOf("/");
		if (slashIdx === -1) {
			files.set(u.path, { hash: u.hash, mode: u.mode ?? "100644" });
		} else {
			const dir = u.path.slice(0, slashIdx);
			const rest = u.path.slice(slashIdx + 1);
			let group = dirs.get(dir);
			if (!group) {
				group = [];
				dirs.set(dir, group);
			}
			group.push({ ...u, path: rest });
		}
	}

	return { files, dirs };
}

async function readTreeEntries(repo: GitRepo, hash: string): Promise<TreeEntry[]> {
	const raw = await readObject(repo, hash);
	if (raw.type !== "tree") throw new Error(`Expected tree object, got ${raw.type}`);
	return parseTree(raw.content).entries;
}

async function applyUpdates(
	repo: GitRepo,
	treeHash: string | null,
	group: SegmentGroup,
): Promise<string> {
	const entries = new Map<string, TreeEntry>();

	if (treeHash) {
		for (const e of await readTreeEntries(repo, treeHash)) {
			entries.set(e.name, e);
		}
	}

	for (const [name, { hash, mode }] of group.files) {
		if (hash === null) {
			entries.delete(name);
		} else {
			entries.set(name, { name, hash, mode });
		}
	}

	for (const [dir, subUpdates] of group.dirs) {
		const existing = entries.get(dir);
		const existingHash = existing?.mode === "040000" ? existing.hash : null;
		const subGroup = groupBySegment(subUpdates);
		const newSubHash = await applyUpdates(repo, existingHash, subGroup);

		const subEntries = await readTreeEntries(repo, newSubHash);
		if (subEntries.length === 0) {
			entries.delete(dir);
		} else {
			entries.set(dir, { name: dir, hash: newSubHash, mode: "040000" });
		}
	}

	const sorted = [...entries.values()].sort((a, b) => {
		const aKey = a.mode === "040000" ? `${a.name}/` : a.name;
		const bKey = b.mode === "040000" ? `${b.name}/` : b.name;
		return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
	});

	const content = serializeTree({ type: "tree", entries: sorted });
	return writeObject(repo, "tree", content);
}
