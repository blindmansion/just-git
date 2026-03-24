import { readObject, writeObject } from "../lib/object-db.ts";
import { readCommit as _readCommit } from "../lib/object-db.ts";
import { serializeCommit } from "../lib/objects/commit.ts";
import { serializeTag } from "../lib/objects/tag.ts";
import { parseTree, serializeTree } from "../lib/objects/tree.ts";
import { resolveRef as _resolveRef } from "../lib/refs.ts";
import type { GitRepo, Identity, ObjectType, TreeEntry } from "../lib/types.ts";

// ── Identity helpers ────────────────────────────────────────────────

/**
 * Simplified identity for the public API. When `date` is omitted,
 * defaults to the current time. Accepts either this form or the
 * internal `Identity` (with `timestamp`/`timezone`) for full control.
 */
export interface CommitAuthor {
	name: string;
	email: string;
	/** Defaults to `new Date()` (current time). */
	date?: Date;
}

/** Accepts either the simplified {@link CommitAuthor} or the internal `Identity` with raw timestamp/timezone. */
export type CommitIdentity = CommitAuthor | Identity;

function formatTimezone(offsetMinutes: number): string {
	const abs = Math.abs(offsetMinutes);
	const sign = offsetMinutes <= 0 ? "+" : "-";
	const hours = String(Math.floor(abs / 60)).padStart(2, "0");
	const mins = String(abs % 60).padStart(2, "0");
	return `${sign}${hours}${mins}`;
}

function toIdentity(input: CommitIdentity): Identity {
	if ("timestamp" in input) return input as Identity;
	const date = input.date ?? new Date();
	return {
		name: input.name,
		email: input.email,
		timestamp: Math.floor(date.getTime() / 1000),
		timezone: formatTimezone(date.getTimezoneOffset()),
	};
}

// ── Commit creation ─────────────────────────────────────────────────

/** Options for {@link createCommit}. */
export interface CreateCommitOptions {
	/** Hash of the tree object for this commit. */
	tree: string;
	/** Parent commit hashes (empty for root commits). */
	parents: string[];
	/** Author identity. Accepts `{ name, email, date? }` or full `Identity`. */
	author: CommitIdentity;
	/** Committer identity. Defaults to `author` when omitted. */
	committer?: CommitIdentity;
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
	const author = toIdentity(options.author);
	const committer = options.committer ? toIdentity(options.committer) : author;
	const content = serializeCommit({
		type: "commit",
		tree: options.tree,
		parents: options.parents,
		author,
		committer,
		message: options.message,
	});
	const hash = await writeObject(repo, "commit", content);

	if (options.branch) {
		await advanceBranch(repo, options.branch, hash);
	}

	return hash;
}

// ── Annotated tag creation ───────────────────────────────────────────

/** Options for {@link createAnnotatedTag}. */
export interface CreateAnnotatedTagOptions {
	/** Hash of the target object (usually a commit). */
	target: string;
	/** Tag name (written into the tag object and used for the ref). */
	name: string;
	/** Tagger identity. Accepts `{ name, email, date? }` or full `Identity`. */
	tagger: CommitIdentity;
	message: string;
	/** Type of the target object. Defaults to `"commit"`. */
	targetType?: ObjectType;
}

/**
 * Create an annotated tag object and its ref.
 * Returns the tag object's hash.
 *
 * ```ts
 * await createAnnotatedTag(repo, {
 *   target: commitHash,
 *   name: "v1.0.0",
 *   tagger: { name: "Alice", email: "alice@example.com" },
 *   message: "Release 1.0.0",
 * });
 * ```
 */
export async function createAnnotatedTag(
	repo: GitRepo,
	options: CreateAnnotatedTagOptions,
): Promise<string> {
	const tagger = toIdentity(options.tagger);
	const content = serializeTag({
		type: "tag",
		object: options.target,
		objectType: options.targetType ?? "commit",
		name: options.name,
		tagger,
		message: options.message,
	});
	const hash = await writeObject(repo, "tag", content);
	await repo.refStore.writeRef(`refs/tags/${options.name}`, { type: "direct", hash });
	return hash;
}

// ── High-level commit ───────────────────────────────────────────────

/** Options for {@link buildCommit}. */
export interface BuildCommitOptions {
	/**
	 * Files to add, update, or delete.
	 * - `string` values are written as UTF-8 blobs.
	 * - `Uint8Array` values are written as raw blobs.
	 * - `null` deletes the file from the tree.
	 */
	files: Record<string, string | Uint8Array | null>;
	message: string;
	/** Author identity. Accepts `{ name, email, date? }` or full `Identity`. Timestamp defaults to now. */
	author: CommitIdentity;
	/** Committer identity. Defaults to `author` when omitted. */
	committer?: CommitIdentity;
	/**
	 * Branch to read the parent commit from. The new commit builds on
	 * top of this branch's tree. When omitted, creates a root commit
	 * with only the specified files.
	 */
	branch?: string;
}

/** Result of {@link buildCommit}. */
export interface CommitResult {
	/** The new commit's hash. */
	hash: string;
	/** The parent commit hash, or `null` for root commits. Useful as `oldHash` for CAS-protected ref updates. */
	parentHash: string | null;
}

/**
 * Create a commit from files without advancing any refs.
 *
 * Handles blob creation, tree construction, and parent resolution.
 * When `branch` is provided and the branch exists, the specified
 * files are applied on top of the existing tree (unmentioned files
 * are preserved). When the branch doesn't exist or is omitted, a
 * root commit is created with only the specified files.
 *
 * Returns both the commit hash and the parent hash. The parent hash
 * is useful as `oldHash` for CAS-protected ref updates via
 * `server.updateRefs()` or `server.commit()`.
 *
 * ```ts
 * const { hash, parentHash } = await buildCommit(repo, {
 *   files: { "README.md": "# Hello\n" },
 *   message: "initial commit",
 *   author: { name: "Alice", email: "alice@example.com" },
 *   branch: "main",
 * });
 * ```
 */
export async function buildCommit(
	repo: GitRepo,
	options: BuildCommitOptions,
): Promise<CommitResult> {
	const branchRef = options.branch ? `refs/heads/${options.branch}` : null;
	const parentHash = branchRef ? await _resolveRef(repo, branchRef) : null;

	let existingTreeHash: string | null = null;
	if (parentHash) {
		const parentCommit = await _readCommit(repo, parentHash);
		existingTreeHash = parentCommit.tree;
	}

	const updates: TreeUpdate[] = [];
	for (const [path, content] of Object.entries(options.files)) {
		if (content === null) {
			updates.push({ path, hash: null });
		} else {
			const blobData = typeof content === "string" ? new TextEncoder().encode(content) : content;
			const blobHash = await writeObject(repo, "blob", blobData);
			updates.push({ path, hash: blobHash });
		}
	}

	let treeHash: string;
	if (existingTreeHash) {
		treeHash = await updateTree(repo, existingTreeHash, updates);
	} else {
		treeHash = await applyUpdates(repo, null, groupBySegment(updates));
	}

	const author = toIdentity(options.author);
	const committer = options.committer ? toIdentity(options.committer) : author;
	const parents = parentHash ? [parentHash] : [];

	const content = serializeCommit({
		type: "commit",
		tree: treeHash,
		parents,
		author,
		committer,
		message: options.message,
	});
	const hash = await writeObject(repo, "commit", content);

	return { hash, parentHash };
}

/** Options for {@link commit}. */
export interface CommitOptions {
	/**
	 * Files to add, update, or delete.
	 * - `string` values are written as UTF-8 blobs.
	 * - `Uint8Array` values are written as raw blobs.
	 * - `null` deletes the file from the tree.
	 */
	files: Record<string, string | Uint8Array | null>;
	message: string;
	/** Author identity. Accepts `{ name, email, date? }` or full `Identity`. Timestamp defaults to now. */
	author: CommitIdentity;
	/** Committer identity. Defaults to `author` when omitted. */
	committer?: CommitIdentity;
	/** Branch to commit to. Parent is auto-resolved from the current branch tip. */
	branch: string;
}

/**
 * Commit files to a branch in one call.
 *
 * Handles blob creation, tree construction, parent resolution, and
 * ref advancement. When the branch already exists, the specified
 * files are applied on top of the existing tree (unmentioned files
 * are preserved). When the branch doesn't exist, a root commit is
 * created with only the specified files.
 *
 * For server-backed repos where hook enforcement and CAS protection
 * are needed, use `server.commit()` instead — it uses
 * {@link buildCommit} + `server.updateRefs()` internally.
 *
 * ```ts
 * await commit(repo, {
 *   files: { "README.md": "# Hello\n", "src/index.ts": "export {};\n" },
 *   message: "initial commit",
 *   author: { name: "Alice", email: "alice@example.com" },
 *   branch: "main",
 * });
 * ```
 */
export async function commit(repo: GitRepo, options: CommitOptions): Promise<string> {
	const { hash } = await buildCommit(repo, options);
	await advanceBranch(repo, options.branch, hash);
	return hash;
}

async function advanceBranch(repo: GitRepo, branch: string, hash: string): Promise<void> {
	const branchRef = `refs/heads/${branch}`;
	await repo.refStore.writeRef(branchRef, { type: "direct", hash });
	const head = await repo.refStore.readRef("HEAD");
	if (!head) {
		await repo.refStore.writeRef("HEAD", { type: "symbolic", target: branchRef });
	}
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
