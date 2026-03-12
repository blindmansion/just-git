import type { FileSystem } from "../fs.ts";
import type {
	CredentialProvider,
	FetchFunction,
	HookEmitter,
	IdentityOverride,
	NetworkPolicy,
} from "../hooks.ts";
import type { PackedObjectStore } from "./object-store.ts";

// ── Object identifiers ──────────────────────────────────────────────

/** 40-character lowercase hex SHA-1 hash. */
export type ObjectId = string;

/** The four Git object types. */
export type ObjectType = "blob" | "tree" | "commit" | "tag";

// ── Raw object (before parsing) ─────────────────────────────────────

/** An object as stored in .git/objects — type + raw content bytes. */
export interface RawObject {
	type: ObjectType;
	content: Uint8Array;
}

// ── Parsed object types ─────────────────────────────────────────────

export interface TreeEntry {
	/** e.g. "100644", "040000", "100755", "120000", "160000" */
	mode: string;
	name: string;
	hash: ObjectId;
}

export interface Tree {
	type: "tree";
	entries: TreeEntry[];
}

/** Author or committer identity with timestamp. */
export interface Identity {
	name: string;
	email: string;
	/** Unix epoch seconds. */
	timestamp: number;
	/** Timezone offset string, e.g. "+0000", "-0500". */
	timezone: string;
}

export interface Commit {
	type: "commit";
	tree: ObjectId;
	parents: ObjectId[];
	author: Identity;
	committer: Identity;
	message: string;
}

export interface Tag {
	type: "tag";
	/** The object this tag points to. */
	object: ObjectId;
	/** The type of the tagged object (usually "commit"). */
	objectType: ObjectType;
	/** The tag name. */
	name: string;
	tagger: Identity;
	message: string;
}

// ── File modes ──────────────────────────────────────────────────────

export const FileMode = {
	/** Regular non-executable file. */
	REGULAR: "100644",
	/** Executable file. */
	EXECUTABLE: "100755",
	/** Symbolic link. */
	SYMLINK: "120000",
	/** Tree (directory) — used in tree entries. */
	DIRECTORY: "040000",
	/** Git submodule. */
	SUBMODULE: "160000",
} as const;

export type FileMode = (typeof FileMode)[keyof typeof FileMode];

// ── References ──────────────────────────────────────────────────────

export interface SymbolicRef {
	type: "symbolic";
	/** The ref path this points to, e.g. "refs/heads/main". */
	target: string;
}

export interface DirectRef {
	type: "direct";
	hash: ObjectId;
}

export type Ref = SymbolicRef | DirectRef;

// ── Index (staging area) ────────────────────────────────────────────

/** Stat-like metadata stored per index entry. */
export interface IndexStat {
	ctimeSeconds: number;
	ctimeNanoseconds: number;
	mtimeSeconds: number;
	mtimeNanoseconds: number;
	dev: number;
	ino: number;
	uid: number;
	gid: number;
	size: number;
}

export interface IndexEntry {
	/** File path relative to the work tree root. */
	path: string;
	/** File mode as a numeric value (e.g. 0o100644). */
	mode: number;
	/** SHA-1 of the blob content. */
	hash: ObjectId;
	/** Merge stage: 0 = normal, 1 = base, 2 = ours, 3 = theirs. */
	stage: number;
	stat: IndexStat;
}

export interface Index {
	version: number;
	entries: IndexEntry[];
}

// ── Repository context ──────────────────────────────────────────────

/**
 * Bundles the filesystem handle with resolved repository paths.
 * Threaded through all library functions so they don't need to
 * re-discover the .git directory on every call.
 */
export interface GitContext {
	fs: FileSystem;
	/** Absolute path to the .git directory. */
	gitDir: string;
	/** Absolute path to the working tree root, or null for bare repos. */
	workTree: string | null;
	/** Hook emitter for operation hooks and low-level events. */
	hooks?: HookEmitter;
	/** Operator-provided credential resolver (bypasses env vars). */
	credentialProvider?: CredentialProvider;
	/** Operator-provided identity override for author/committer. */
	identityOverride?: IdentityOverride;
	/** Custom fetch function for HTTP transport. Falls back to globalThis.fetch. */
	fetchFn?: FetchFunction;
	/** Network access policy. `false` blocks all HTTP access. */
	networkPolicy?: NetworkPolicy | false;
	/** Cached object store instance. Lazily created by object-db. */
	objectStore?: PackedObjectStore;
}

// ── Diff result types ───────────────────────────────────────────────

export type DiffStatus = "added" | "deleted" | "modified";

export interface TreeDiffEntry {
	path: string;
	status: DiffStatus;
	/** Hash in tree A (undefined if added). */
	oldHash?: ObjectId;
	/** Hash in tree B (undefined if deleted). */
	newHash?: ObjectId;
	oldMode?: string;
	newMode?: string;
}

export interface WorkTreeDiff {
	path: string;
	status: DiffStatus | "untracked";
	/** Index hash (undefined if untracked). */
	indexHash?: ObjectId;
}
