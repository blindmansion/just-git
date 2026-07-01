import type { FileSystem } from "../fs.ts";
import type {
	ConfigOverrides,
	FetchFunction,
	GitHooks,
	IdentityOverride,
	ProgressCallback,
} from "../hooks.ts";
import type { AttributeResolver } from "./attribute-resolver.ts";
import type { AttributesProvider } from "./attributes.ts";
import type { PackObject } from "./pack/packfile.ts";
import type { SigningCapability } from "./signing.ts";

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
	/**
	 * Armored signature block (e.g. `-----BEGIN PGP SIGNATURE-----`),
	 * stored verbatim with continuation-line indentation already stripped.
	 * Present only for signed commits. Serialized as the `gpgsig` header
	 * (after `committer`, before the blank line) with continuation lines
	 * re-indented by one space. The bytes that get signed/verified are
	 * produced by `commitSigningPayload` (the commit text with this header
	 * removed).
	 */
	gpgsig?: string;
	/**
	 * Commit headers just-git does not model individually (`encoding`,
	 * `mergetag`, and any future or third-party headers such as `HG:rename`),
	 * captured as ordered `[key, value]` pairs so an object read from real git
	 * re-serializes byte-for-byte — preserving its hash. Excludes the modeled
	 * headers (`tree`, `parent`, `author`, `committer`, `gpgsig`). Values are
	 * stored verbatim with continuation-line indentation stripped (multi-line
	 * values like `mergetag` keep their internal newlines), and are emitted
	 * after `committer` in their original order, before `gpgsig`. Present only
	 * when the object carried such headers.
	 */
	extraHeaders?: [string, string][];
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
	/**
	 * Armored signature block for a signed annotated tag. Unlike a commit's
	 * `gpgsig` header, a tag signature is appended verbatim after the message
	 * body (this is how real git stores it). The signed/verified bytes are
	 * produced by `tagSigningPayload` (the tag text without this trailing
	 * block). Present only for signed tags.
	 */
	gpgsig?: string;
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
	readMany?(hashes: ReadonlyArray<ObjectId>): Promise<Map<ObjectId, RawObject>>;
	write(type: ObjectType, content: Uint8Array): Promise<ObjectId>;
	exists(hash: ObjectId): Promise<boolean>;
	existsMany?(hashes: ReadonlyArray<ObjectId>): Promise<Set<ObjectId>>;
	ingestPack(packData: Uint8Array): Promise<number>;
	/**
	 * Ingest pre-resolved objects from a streaming source.
	 * Accepts the output of `readPackStreaming` — each yielded
	 * `PackObject` has type, content, and hash already computed.
	 */
	ingestPackStream(entries: AsyncIterable<PackObject>): Promise<number>;
	/** Return all object hashes matching a hex prefix (for short hash resolution). */
	findByPrefix(prefix: string): Promise<ObjectId[]>;
	/**
	 * Signal that pack files on disk have changed externally (e.g. after
	 * repack or gc). Implementations should discard cached pack state
	 * and re-scan on the next read.
	 */
	invalidatePacks?(): void;
}

// ── Transport discovery cache ───────────────────────────────────────

/**
 * Serializable snapshot of a v2 capability advertisement. Holds only the raw
 * capability lines (`fetch=…`, `ls-refs=…`, `object-format=…`) plus the
 * resolved hash format, from which a full `V2Capabilities` is rebuilt — no
 * `Map` to serialize, so a host can persist this to shared storage.
 */
export interface V2CapabilitiesSnapshot {
	/** Raw capability lines as advertised (excluding `version 2`). */
	raw: string[];
	/** The server's resolved `object-format` (defaults to `sha1`). */
	objectFormat: string;
}

/**
 * A cached discovery result for one remote origin: the protocol version the
 * server agreed to plus its (stable) capabilities. Deliberately holds **no ref
 * values** — ref churn is the point of syncing, so refs are only ever reused
 * behind an HTTP validator (see `etag`). Capabilities are advisory: a stale
 * entry costs at most one wasted request, never a wrong answer.
 */
export interface DiscoveryEntry {
	protocolVersion: 1 | 2;
	/** Upload-pack capabilities: a v2 snapshot, or a v1 cap list + object-format. */
	uploadPack: { v2: V2CapabilitiesSnapshot } | { v1: string[]; objectFormat: string };
	/** Receive-pack (push) capabilities, present once push discovery has run. */
	receivePack?: { caps: string[] };
	/** HTTP validator from the `info/refs` response, for conditional `GET`. */
	etag?: string;
	/** Wall-clock fetch time in epoch ms, for TTL bounding. */
	fetchedAt: number;
}

/**
 * Cross-operation cache of stable per-remote protocol discovery (version +
 * capabilities), keyed by `new URL(url).origin`. Injected via
 * {@link RepoCapabilities.discoveryCache}; the host owns its lifetime so it can
 * survive a whole sync loop. Absent ⇒ today's per-instance behavior. The
 * transport only reads/writes it to *suppress* requests whose answer it already
 * holds — nothing here is ever sent on the wire, so third-party servers
 * (GitHub/GitLab) are unaffected.
 */
export interface DiscoveryCache {
	get(origin: string): DiscoveryEntry | undefined | Promise<DiscoveryEntry | undefined>;
	set(origin: string, entry: DiscoveryEntry): void | Promise<void>;
	/** Drop a stale entry after a protocol error, forcing one re-discovery. */
	evict?(origin: string): void | Promise<void>;
}

// ── Repository context ──────────────────────────────────────────────

/**
 * Host-provided behavior for git operations: the single capability
 * vocabulary shared by every entry point. Supplied once as defaults
 * (`createGit` / `createRepoStore` / `createServer`), attached to a repo
 * handle via `withCapabilities`, and (for now) still overridable per-call
 * where a function exposes the matching option.
 *
 * Every field is optional; an absent field means "use the built-in
 * default". This is the additive first cut — it deliberately mirrors
 * today's loose fields (`GitRepo.hooks`/`.signing`, the `GitContext`
 * operator fields, and the per-call `mergeDriver`) under one name so
 * later phases can migrate reads onto it and then delete the originals.
 */
export interface RepoCapabilities {
	/** Operation hooks and low-level events. */
	hooks?: GitHooks;
	/** Commit/tag signing (write) + verification (read). */
	signing?: SigningCapability;
	/**
	 * The single `.gitattributes`-driven seam: resolve which behaviors (content
	 * filter, merge driver, …) apply to a path. The sole attribute capability on
	 * a handle — registries (`filter=`/`merge=` name → impl), host-locked policy,
	 * defaults, and computed rules are all composed *into* the resolver, not
	 * carried as separate fields. Build one with the shipped `gitAttributes({…})`
	 * helper (in-tree `.gitattributes` selection + registries) or `everyPath({…})`
	 * (apply one behavior to all paths — the legacy global merge-driver/filters
	 * ergonomic). When absent, no attribute-driven behavior applies (plain diff3
	 * merges, no content filtering).
	 */
	attributes?: AttributeResolver;
	/** Author/committer identity override (locked or fallback). */
	identity?: IdentityOverride;
	/** Locked + default git config values. */
	config?: ConfigOverrides;
	/**
	 * The single network seam: resolve how to reach a remote (an HTTP fetch or
	 * an in-process repo). The sole network capability on a handle — policy,
	 * credentials, retry, and cross-VFS resolution are all composed *into* the
	 * resolver, not carried as separate fields. Build one with the shipped
	 * `httpTransport({…})` / `pipe(allowlist, withAuth, …)` builders (the
	 * `createGit` `network`/`credentials`/`resolveRemote` options are sugar that
	 * compile into this). When absent, the core uses a git-faithful default
	 * (env auth, URL-embedded credentials, Smart HTTP), falling back to local
	 * filesystem repo discovery.
	 */
	transport?: TransportResolver;
	/** Receives server progress messages (sideband band-2). */
	onProgress?: ProgressCallback;

	/**
	 * Cross-operation cache of stable per-remote protocol discovery (version +
	 * capabilities). When set, a {@link SmartHttpTransport} consults it before
	 * issuing the capability `GET /info/refs` and skips that round-trip on a hit,
	 * so a tight sync loop stops re-discovering the same server every cycle.
	 *
	 * Purely advisory and safe by default: it caches only version + caps (never
	 * ref values), is TTL-bounded, and self-corrects by evicting + re-discovering
	 * on any protocol error — so a stale entry costs at most one wasted request,
	 * never a wrong result. Absent ⇒ per-instance discovery only (today's
	 * behavior). Build the shipped default with `createMemoryDiscoveryCache()`.
	 */
	discoveryCache?: DiscoveryCache;
	/**
	 * Injected clock. Supplies the "current time" for author/committer
	 * timestamps (when no `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` is given),
	 * reflog entries, and the gc reflog-expiry cutoff. Absent ⇒ the system
	 * clock (`new Date()`). Set it once on the handle for deterministic time
	 * in tests or a host-controlled clock in multi-tenant servers — the
	 * non-env counterpart to the `GIT_*_DATE` vars. Returns a `Date`; the
	 * timezone of recorded timestamps is unchanged (still derived as today).
	 */
	now?: () => Date;
}

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
	/**
	 * The single channel for host-provided behavior (hooks, signing, merge
	 * driver, identity, config, transport, progress). Attached
	 * via `withCapabilities`; never auto-populated by a storage backend, so
	 * a bare handle is inert until a host opts in. Every capability read in
	 * the SDK, command, and server layers resolves through here.
	 */
	capabilities?: RepoCapabilities;
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
	/**
	 * Absolute path to the per-worktree private `$GIT_DIR`. Holds this
	 * worktree's HEAD, index, `logs/HEAD`, operation state (MERGE_HEAD,
	 * CHERRY_PICK_HEAD, REVERT_HEAD, ORIG_HEAD), and the per-worktree ref
	 * namespaces (`refs/bisect|worktree|rewritten`).
	 */
	gitDir: string;
	/**
	 * Absolute path to the shared `$GIT_COMMON_DIR`. Holds the state shared
	 * across all worktrees: objects, `refs/heads|tags|remotes`, `packed-refs`,
	 * config, and `logs/refs/*`. Equals `gitDir` in a plain repo, a bare repo,
	 * and the main worktree; it differs only inside a linked worktree.
	 */
	commonDir: string;
	/** Absolute path to the working tree root, or null for bare repos. */
	workTree: string | null;
}

// ── Capability context ──────────────────────────────────────────────

/** The git operation driving a capability resolver. */
export type GitOperation =
	| "commit"
	| "merge"
	| "rebase"
	| "cherry-pick"
	| "revert"
	| "clone"
	| "fetch"
	| "push"
	| "pull"
	| "ls-remote"
	| "tag"
	// Worktree-conversion operations that drive content filters.
	| "checkout"
	| "add"
	| "status"
	// Display-only diff rendering (textconv / binariness / hunk headers).
	| "diff";

/**
 * Read-only view over resolved config: parsed `.git/config` merged with the
 * static `capabilities.config` overrides (a `locked` value wins, then the
 * on-disk value, then a `defaults` fallback). Synchronous — built from a
 * one-time snapshot, so a resolver can read config without re-touching the
 * filesystem on every call.
 */
export interface ConfigView {
	get(dottedKey: string): string | undefined;
	getAll(dottedKey: string): string[];
}

/**
 * The single context handed to every function-shaped capability (the
 * `mergeDriver` today; `transport` and `filters` later) as the mandatory first
 * argument, ahead of any operation-specific data.
 *
 * The object is always constructed by the core; individual fields may be
 * absent — a bare store-backed handle has no `gitDir`/`env` and gets an empty
 * `config` view, and `url` is present only for transport operations.
 * `identity` is deliberately NOT carried here: no capability consumes it (it is
 * itself a producer the core invokes to build a commit/tag), and leaving it out
 * keeps the most expensive, fallible derivation off the context — building the
 * context for a merge can never throw "please tell me who you are".
 */
export interface CapabilityContext {
	/** Which git operation is driving this resolver. */
	operation: GitOperation;
	/**
	 * The handle the operation runs against. Stores are exposed for advanced
	 * resolvers (semantic merge drivers, content filters); the common case
	 * reads only `config`.
	 */
	repo: {
		id?: string;
		gitDir?: string;
		objectStore: ObjectStore;
		refStore: RefStore;
	};
	/** Effective config view; an empty view for bare, config-less handles. */
	config: ConfigView;
	/**
	 * In-tree `.gitattributes` lookup, built by the core at the bind boundary
	 * from the handle's work tree (`info/attributes` > `.gitattributes`
	 * deep→shallow). This is how an {@link AttributeResolver} reads on-disk
	 * attributes without the seam carrying an `fs`: a bare, fs-less handle gets
	 * an empty provider (every lookup resolves to "unspecified"), so a resolver
	 * driven purely by host policy / computed rules stays GitRepo-portable.
	 */
	attributes: AttributesProvider;
	/** CLI env, when driven through the front door; absent on the bare SDK path. */
	env?: ReadonlyMap<string, string>;
	/** Target URL — present only for transport operations. */
	url?: string;
}

// ── Transport resolver ──────────────────────────────────────────────

/**
 * What a {@link TransportResolver} resolves a remote URL to: either an HTTP
 * fetch (auth/policy/retry already baked in by the resolver) for Smart HTTP, or
 * an in-process {@link GitRepo} for cross-VFS transport.
 */
export type TransportTarget =
	| { kind: "http"; fetch: FetchFunction }
	| { kind: "repo"; repo: GitRepo };

/**
 * The single network seam. Given the {@link CapabilityContext} (whose `url`
 * carries the target remote), decide how to reach it. Returning `null` defers
 * to the core's default local-path/filesystem resolution.
 */
export type TransportResolver = (
	ctx: CapabilityContext,
) => TransportTarget | null | Promise<TransportTarget | null>;

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
