import type { FileSystem } from "../fs.ts";
import type {
	ConfigOverrides,
	CredentialProvider,
	FetchFunction,
	GitHooks,
	IdentityOverride,
	NetworkPolicy,
} from "../hooks.ts";

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

/** Normalize a `Ref | string` argument to a `Ref`. */
export function normalizeRef(ref: Ref | string): Ref {
	return typeof ref === "string" ? { type: "direct", hash: ref } : ref;
}

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

// ── Ref store ───────────────────────────────────────────────────────

/** A resolved ref name and its target commit hash. */
export interface RefEntry {
	name: string;
	hash: ObjectId;
}

/**
 * Abstract ref storage backend.
 * Implementations handle reading, writing, deleting, and listing git refs.
 * The default filesystem-backed implementation is `FileSystemRefStore`.
 */
export interface RefStore {
	/** Read a single ref without following symbolic refs. */
	readRef(name: string): Promise<Ref | null>;
	/**
	 * Write a ref. Accepts a `Ref` object or a plain hash string
	 * (shorthand for `{ type: "direct", hash }`).
	 */
	writeRef(name: string, ref: Ref | string): Promise<void>;
	/** Delete a ref from storage. */
	deleteRef(name: string): Promise<void>;
	/** List all refs under a prefix, returning resolved hashes. */
	listRefs(prefix?: string): Promise<RefEntry[]>;
	/**
	 * Atomically update a ref only if its current resolved hash matches
	 * `expectedOldHash`. Returns true on success, false if the ref has
	 * been modified concurrently.
	 *
	 * - `expectedOldHash === null` — create-only: fails if the ref exists.
	 * - `expectedOldHash === "<hash>"` — fails if current hash !== expected.
	 * - `newRef === null` — conditional delete.
	 * - `newRef === Ref` — conditional create/update.
	 */
	compareAndSwapRef(
		name: string,
		expectedOldHash: string | null,
		newRef: Ref | null,
	): Promise<boolean>;
}

// ── Object store ────────────────────────────────────────────────────

/**
 * Abstract object storage backend.
 * Implementations handle reading, writing, and querying git objects.
 * The default filesystem-backed implementation is `PackedObjectStore`.
 */
export interface ObjectStore {
	read(hash: ObjectId): Promise<RawObject>;
	write(type: ObjectType, content: Uint8Array): Promise<ObjectId>;
	exists(hash: ObjectId): Promise<boolean>;
	ingestPack(packData: Uint8Array): Promise<number>;
	/** Return all object hashes matching a hex prefix (for short hash resolution). */
	findByPrefix(prefix: string): Promise<ObjectId[]>;
	/**
	 * Signal that pack files on disk have changed externally (e.g. after
	 * repack or gc). Implementations should discard cached pack state
	 * and re-scan on the next read.
	 */
	invalidatePacks?(): void;
}

// ── Repository context ──────────────────────────────────────────────

/**
 * Minimal repository handle: object store + ref store + hooks.
 * Sufficient for all pure object/ref operations (read, write, walk,
 * diff trees, merge-base, blame, etc.) without filesystem access.
 *
 * Used directly by the server module and accepted by ~35 lib functions.
 */
export interface GitRepo {
	objectStore: ObjectStore;
	refStore: RefStore;
	/** Hook callbacks for operation hooks and low-level events. */
	hooks?: GitHooks;
}

/**
 * Resolves a remote URL to a GitRepo, enabling cross-VFS transport.
 * Called before local filesystem lookup for non-HTTP URLs.
 * Return null to fall back to local filesystem resolution.
 */
export type RemoteResolver = (url: string) => GitRepo | null | Promise<GitRepo | null>;

/**
 * Full repository context including filesystem access.
 * Extends `GitRepo` with the filesystem handle, resolved paths,
 * and operator-level extensions (credentials, identity, network).
 *
 * Threaded through command handlers and lib functions that need
 * worktree/index/config/reflog access.
 */
export interface GitContext extends GitRepo {
	fs: FileSystem;
	/** Absolute path to the .git directory. */
	gitDir: string;
	/** Absolute path to the working tree root, or null for bare repos. */
	workTree: string | null;
	/** Operator-provided credential resolver (bypasses env vars). */
	credentialProvider?: CredentialProvider;
	/** Operator-provided identity override for author/committer. */
	identityOverride?: IdentityOverride;
	/** Custom fetch function for HTTP transport. Falls back to globalThis.fetch. */
	fetchFn?: FetchFunction;
	/** Network access policy. `false` blocks all HTTP access. */
	networkPolicy?: NetworkPolicy | false;
	/** Resolves remote URLs to GitRepos on potentially different VFS instances. */
	resolveRemote?: RemoteResolver;
	/** Operator-provided config overrides (locked values + defaults). */
	configOverrides?: ConfigOverrides;
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
