import type { FileSystem } from "../fs.ts";
import type { GitExtensions } from "../git.ts";
import { configBool, readConfigView } from "./config.ts";
import { resolveIdentityFrom } from "./identity.ts";
import { hasConflicts, readIndex, writeIndex } from "./index.ts";
import { findObjectsByPrefix, peelToCommit, readCommit, writeObject } from "./object-db.ts";
import { serializeCommit } from "./objects/commit.ts";
import { relative } from "./path.ts";
import { logRef } from "./reflog.ts";
import { withCapabilities } from "./capabilities.ts";
import { advanceBranchRef, readHead, resolveHead, resolveRef } from "./refs.ts";
import { findRepo } from "./repo.ts";
import { resolveRevision } from "./rev-parse.ts";
import {
	type Signer,
	asSignatureFormat,
	commitSigningPayload,
	resolveVerifierOpts,
} from "./signing.ts";
import { flattenTreeToMap } from "./tree-ops.ts";
import type {
	Commit,
	ConfigView,
	GitContext,
	GitRepo,
	Identity,
	Index,
	ObjectId,
} from "./types.ts";
import { applyWorktreeOps, mergeAbort } from "./unpack-trees.ts";
import { diffIndexToWorkTree } from "./worktree.ts";
import { type CommandResult, err, fatal } from "./command-errors.ts";

const NOT_A_GIT_REPO = fatal("not a git repository (or any of the parent directories): .git");

const NOT_A_WORK_TREE = fatal("this operation must be run in a work tree");

/**
 * Resolve the git context for the current working directory.
 * Returns either a GitContext or a pre-built error result for
 * "not a git repository".
 *
 * When `ext` is provided, the returned GitContext carries operator-level
 * extensions (hooks, credential provider, identity override).
 *
 * When extensions carry pre-resolved `objectStore`, `refStore`, and
 * `gitDir`, filesystem discovery via `findRepo` is skipped entirely —
 * no `.git` directory needs to exist on the VFS.
 */
export async function requireGitContext(
	fs: FileSystem,
	cwd: string,
	ext?: GitExtensions,
): Promise<GitContext | CommandResult> {
	const loc = ext?.locators;
	if (loc?.objectStore && loc?.refStore && loc?.gitDir) {
		return withCapabilities(
			{
				fs,
				gitDir: loc.gitDir,
				commonDir: loc.commonDir ?? loc.gitDir,
				workTree: loc.workTree ?? cwd,
				objectStore: loc.objectStore,
				refStore: loc.refStore,
			},
			ext?.capabilities,
		);
	}

	const ctx = await findRepo(fs, cwd);
	if (!ctx) return NOT_A_GIT_REPO;
	if (!ext) return ctx;
	// Hybrid path: locator stores (without a gitDir) override the discovered
	// context's object/ref stores, while the filesystem still supplies the
	// worktree, index, and config (e.g. a VFS worktree over a SQLite store).
	return withCapabilities(
		{
			...ctx,
			...(loc?.objectStore ? { objectStore: loc.objectStore } : {}),
			...(loc?.refStore ? { refStore: loc.refStore } : {}),
			...(loc?.commonDir ? { commonDir: loc.commonDir } : {}),
		},
		ext.capabilities,
	);
}

/**
 * Guard that the git context has a working tree.
 * Returns the error result if it doesn't, or null if it does.
 */
export function requireWorkTree(gitCtx: GitContext): CommandResult | null {
	if (!gitCtx.workTree) return NOT_A_WORK_TREE;
	return null;
}

/**
 * Resolve HEAD to an ObjectId, returning an error if no commits exist.
 */
export async function requireHead(gitCtx: GitRepo): Promise<ObjectId | CommandResult> {
	const hash = await resolveHead(gitCtx);
	if (!hash) return fatal("your current branch does not have any commits yet");
	return hash;
}

/**
 * Return an error result if the index contains unmerged (conflicted) entries.
 * Returns null when clean.
 */
export function requireNoConflicts(
	index: Index,
	verb: string,
	fatalLine = "fatal: Exiting because of an unresolved conflict.\n",
): CommandResult | null {
	if (!hasConflicts(index)) return null;
	return err(
		`error: ${verb} is not possible because you have unmerged files.\n` +
			"hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
			"hint: as appropriate to mark resolution and make a commit.\n" +
			fatalLine,
		128,
	);
}

/**
 * Resolve a revision string to an ObjectId, returning a fatal error on failure.
 * The error message defaults to `"bad revision '<rev>'"`.
 */
export async function requireRevision(
	gitCtx: GitContext,
	rev: string,
	errorMsg?: string,
): Promise<ObjectId | CommandResult> {
	const hash = await resolveRevision(gitCtx, rev);
	if (!hash) return fatal(errorMsg ?? `bad revision '${rev}'`);
	return hash;
}

/**
 * Resolve a revision to a commit hash + parsed commit object, peeling
 * through tags. Returns a fatal error if the revision doesn't resolve
 * or doesn't point to a commit.
 */
export async function requireCommit(
	gitCtx: GitContext,
	rev: string,
	errorMsg?: string,
): Promise<{ hash: ObjectId; commit: Commit } | CommandResult> {
	const resolved = await resolveRevision(gitCtx, rev);
	if (!resolved) return fatal(errorMsg ?? `bad revision '${rev}'`);
	try {
		const hash = await peelToCommit(gitCtx, resolved);
		const commit = await readCommit(gitCtx, hash);
		return { hash, commit };
	} catch {
		return fatal(errorMsg ?? `bad revision '${rev}'`);
	}
}

/**
 * GitRepo-shaped core of {@link requireCommitter}: resolve the committer
 * identity from a materialized {@link ConfigView}, returning a CommandResult
 * on failure. Pure (no fs).
 */
export function requireCommitterFrom(
	repo: GitRepo,
	config: ConfigView,
	env: Map<string, string>,
): Identity | CommandResult {
	try {
		return resolveIdentityFrom(repo, config, env, "committer");
	} catch (e) {
		return fatal((e as Error).message);
	}
}

/**
 * GitRepo-shaped core of {@link requireAuthor}: resolve the author identity
 * from a materialized {@link ConfigView}, returning a CommandResult on failure.
 * Pure (no fs).
 */
export function requireAuthorFrom(
	repo: GitRepo,
	config: ConfigView,
	env: Map<string, string>,
): Identity | CommandResult {
	try {
		return resolveIdentityFrom(repo, config, env, "author");
	} catch (e) {
		return fatal((e as Error).message);
	}
}

/**
 * Resolve the committer identity, returning a CommandResult on failure.
 * Use with `isCommandError()` to check the result. Imperative-shell wrapper
 * over {@link requireCommitterFrom}.
 */
export async function requireCommitter(
	ctx: GitContext,
	env: Map<string, string>,
): Promise<Identity | CommandResult> {
	return requireCommitterFrom(ctx, await readConfigView(ctx), env);
}

/**
 * Resolve the author identity, returning a CommandResult on failure.
 * Use with `isCommandError()` to check the result. Imperative-shell wrapper
 * over {@link requireAuthorFrom}.
 */
export async function requireAuthor(
	ctx: GitContext,
	env: Map<string, string>,
): Promise<Identity | CommandResult> {
	return requireAuthorFrom(ctx, await readConfigView(ctx), env);
}

/**
 * Check whether the index has staged changes relative to a HEAD tree.
 * Compares stage-0 index entries against the tree map for modifications,
 * additions, and deletions.
 */
export function hasStagedChanges(index: Index, headMap: Map<string, { hash: string }>): boolean {
	const stage0 = new Map<string, { hash: string }>();
	for (const e of index.entries) {
		if (e.stage === 0) stage0.set(e.path, e);
	}
	for (const [path, entry] of stage0) {
		const headEntry = headMap.get(path);
		if (!headEntry || headEntry.hash !== entry.hash) return true;
	}
	for (const [path] of headMap) {
		if (!stage0.has(path)) return true;
	}
	return false;
}

interface SequencerDirtyState {
	hasStaged: boolean;
	hasUnstaged: boolean;
}

export async function getSequencerDirtyState(
	gitCtx: GitContext,
	headHash: ObjectId,
	index: Index,
): Promise<SequencerDirtyState | null> {
	if (!gitCtx.workTree) return null;

	const headCommit = await readCommit(gitCtx, headHash);
	const headMap = await flattenTreeToMap(gitCtx, headCommit.tree);
	const hasStaged = hasStagedChanges(index, headMap);
	const wtDiffs = await diffIndexToWorkTree(gitCtx, index);
	const hasUnstaged = wtDiffs.some((d) => d.status === "modified" || d.status === "deleted");

	if (!hasStaged && !hasUnstaged) return null;
	return { hasStaged, hasUnstaged };
}

export function sequencerDirtyWorktreeError(
	operation: "rebase" | "pull with rebase",
	state: SequencerDirtyState,
	exitCode = 1,
): CommandResult {
	const lines: string[] = [];
	if (state.hasUnstaged) {
		lines.push(`error: cannot ${operation}: You have unstaged changes.`);
	}
	if (state.hasStaged) {
		if (state.hasUnstaged) {
			lines.push("error: additionally, your index contains uncommitted changes.");
		} else {
			lines.push(`error: cannot ${operation}: Your index contains uncommitted changes.`);
		}
	}
	lines.push("error: Please commit or stash them.");
	return err(`${lines.join("\n")}\n`, exitCode);
}

/** Compute the working-directory-relative prefix for pathspec resolution. */
export function getCwdPrefix(gitCtx: GitContext, cwd: string): string {
	return gitCtx.workTree ? relative(gitCtx.workTree, cwd) : "";
}

/** git's minimum auto abbreviation length (FALLBACK_DEFAULT_ABBREV). */
export const DEFAULT_ABBREV = 7;

/**
 * Abbreviate a hash to a fixed length without disambiguation.
 *
 * Prefer {@link uniqueAbbrev} for user-facing output — this fixed-length
 * form can print an ambiguous prefix when another object shares it. Kept for
 * contexts where the object DB isn't available and for building fallbacks.
 */
export function abbreviateHash(hash: ObjectId): string {
	return hash.slice(0, DEFAULT_ABBREV);
}

/**
 * Abbreviate a hash to the shortest prefix (>= {@link DEFAULT_ABBREV}) that
 * uniquely identifies an object in the store, matching git's
 * `find_unique_abbrev`. Extends the prefix while more than one object shares
 * it, so callers never emit an ambiguous short hash.
 */
export async function uniqueAbbrev(
	ctx: GitRepo,
	hash: ObjectId,
	minLen: number = DEFAULT_ABBREV,
): Promise<string> {
	const start = Math.max(minLen, 4);
	for (let len = start; len < hash.length; len++) {
		const matches = await findObjectsByPrefix(ctx, hash.slice(0, len));
		if (matches.length <= 1) return hash.slice(0, len);
	}
	return hash;
}

/**
 * Pre-resolve unique abbreviations for a set of hashes and return a synchronous
 * lookup. Lets sync formatters (log/status output) emit disambiguated short
 * hashes without threading async object-DB access through every call site.
 * Unknown hashes fall back to the fixed-length abbreviation.
 */
export async function buildAbbrevResolver(
	ctx: GitRepo,
	hashes: Iterable<ObjectId>,
): Promise<(hash: ObjectId) => string> {
	const map = new Map<ObjectId, string>();
	await Promise.all(
		[...new Set(hashes)].map(async (h) => {
			map.set(h, await uniqueAbbrev(ctx, h));
		}),
	);
	return (h) => map.get(h) ?? abbreviateHash(h);
}

/** Extract the first line (subject) of a commit message. */
export function firstLine(message: string): string {
	const idx = message.indexOf("\n");
	return idx === -1 ? message : message.slice(0, idx);
}

/**
 * Format the one-line commit header: `[branchName shortHash] firstLine`
 *
 * Uses a disambiguated short hash ({@link uniqueAbbrev}) to match git.
 */
export async function formatCommitOneLiner(
	ctx: GitRepo,
	branchName: string,
	hash: ObjectId,
	message: string,
	rootCommit = false,
): Promise<string> {
	const rootLabel = rootCommit ? " (root-commit)" : "";
	return `[${branchName}${rootLabel} ${await uniqueAbbrev(ctx, hash)}] ${firstLine(message)}`;
}

/**
 * Shared abort logic for merge --abort and cherry-pick --abort.
 */
export async function handleOperationAbort(
	gitCtx: GitContext,
	env: Map<string, string>,
	opts: {
		operationRef: string;
		noOpError: CommandResult;
		operationName: string;
		clearState: (ctx: GitContext) => Promise<void>;
		origHeadAsTargetRev?: boolean;
	},
): Promise<CommandResult> {
	const opHead = await resolveRef(gitCtx, opts.operationRef);
	if (!opHead) return opts.noOpError;

	// A conflicted merge / cherry-pick / revert never advances HEAD, so the
	// abort target is the current HEAD. ORIG_HEAD is a shared pseudo-ref that an
	// earlier, unrelated operation may have left pointing elsewhere, so it can't
	// be trusted here (git resets to the recorded operation start, which for
	// these conflicts is exactly HEAD).
	const targetHead = await resolveHead(gitCtx);
	if (!targetHead) {
		return fatal(`There is no ${opts.operationName} to abort (HEAD missing).`);
	}

	const headBeforeAbort = targetHead;
	const targetCommit = await readCommit(gitCtx, targetHead);
	const currentIndex = await readIndex(gitCtx);

	const abortResult = await mergeAbort(
		gitCtx,
		targetCommit.tree,
		currentIndex,
		opts.origHeadAsTargetRev ? targetHead : undefined,
	);
	if (!abortResult.success) {
		return abortResult.errorOutput as CommandResult;
	}

	await advanceBranchRef(gitCtx, targetHead);
	await writeIndex(gitCtx, { version: 2, entries: abortResult.newEntries });
	await applyWorktreeOps(gitCtx, abortResult.worktreeOps);

	const head = await readHead(gitCtx);
	const isOnBranch = head?.type === "symbolic";
	if (isOnBranch) {
		const resetTarget = opts.origHeadAsTargetRev ? targetHead : "HEAD";
		await logRef(
			gitCtx,
			env,
			"HEAD",
			headBeforeAbort,
			targetHead,
			`reset: moving to ${resetTarget}`,
		);
	}

	await opts.clearState(gitCtx);

	return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Serialize a commit, write it to the object store, and advance the branch ref.
 * Returns the new commit hash.
 *
 * Shared chokepoint behind merge / rebase / cherry-pick / revert / pull. When
 * `sign` is provided, the commit is signed (the `gpgsig` header is filled from
 * {@link commitSigningPayload}); resolve it once per command via
 * {@link resolveCommandSigner}.
 */
export async function writeCommitAndAdvance(
	ctx: GitRepo,
	tree: ObjectId,
	parents: ObjectId[],
	author: Identity,
	committer: Identity,
	message: string,
	sign?: Signer,
): Promise<ObjectId> {
	const commit: Commit = {
		type: "commit",
		tree,
		parents,
		author,
		committer,
		message,
	};
	if (sign) commit.gpgsig = await sign(commitSigningPayload(commit));
	const content = serializeCommit(commit);
	const hash = await writeObject(ctx, "commit", content);
	await advanceBranchRef(ctx, hash);
	return hash;
}

/**
 * Resolve whether a write command should sign, and with what.
 *
 * Layers CLI flag over config over default (mirroring how `merge.ff` /
 * `pull.rebase` resolve): `cliSign ?? configBool(<configKey>) ?? false`.
 * When signing is required, resolves the operator-injected signer
 * (`gitCtx.capabilities.signing.signer`); if none is configured, returns a {@link CommandResult}
 * error (`gpg failed to sign the data`) rather than silently emitting an
 * unsigned object — matching git, and keeping a locked `commit.gpgsign=true`
 * sandbox honest.
 *
 * When signing is on, the key selection git would use is resolved (explicit
 * `keyId` — e.g. `tag -u <keyid>` — falling back to `user.signingkey`) along
 * with `gpg.format`, and both are bound onto the returned signer's `opts` so a
 * multi-key / multi-format backend can act on them. This is policy resolution
 * only: the secret never leaves the backend.
 *
 * Returns:
 * - `undefined` — do not sign.
 * - a {@link Signer} — sign with it (pre-bound with the resolved key/format).
 * - a {@link CommandResult} — error (use {@link isCommandError} to detect).
 */
/**
 * GitRepo-shaped core of {@link resolveCommandSigner}: resolve the signing
 * policy from a materialized {@link ConfigView} (one read instead of three).
 * Pure (no fs).
 */
export function resolveCommandSignerFrom(
	repo: GitRepo,
	config: ConfigView,
	cliSign: boolean | undefined,
	configKey = "commit.gpgsign",
	opts?: { keyId?: string },
): Signer | CommandResult | undefined {
	const shouldSign = cliSign ?? configBool(config.get(configKey)) ?? false;
	if (!shouldSign) return undefined;
	const signer = repo.capabilities?.signing?.signer;
	if (!signer) return err("error: gpg failed to sign the data\n", 128);

	const keyId = opts?.keyId ?? config.get("user.signingkey");
	const format = asSignatureFormat(config.get("gpg.format"));
	if (keyId === undefined && format === undefined) return signer;

	// Bind the resolved selection as defaults so every existing call site
	// (`commit`, `tag`, and the `writeCommitAndAdvance` callers) forwards it
	// without threading extra arguments through each one.
	return (payload, callOpts) => signer(payload, { keyId, format, ...callOpts });
}

export async function resolveCommandSigner(
	gitCtx: GitContext,
	cliSign: boolean | undefined,
	configKey = "commit.gpgsign",
	opts?: { keyId?: string },
): Promise<Signer | CommandResult | undefined> {
	return resolveCommandSignerFrom(gitCtx, await readConfigView(gitCtx), cliSign, configKey, opts);
}

/**
 * Enforce `--verify-signatures` for a commit being integrated (merge / pull).
 *
 * Resolves `cliVerify ?? configBool(<configKey>) ?? false`. When verification
 * is on, reads the commit, reconstructs the signed bytes, and runs the
 * operator-injected verifier. Returns a {@link CommandResult} error (so the
 * caller aborts) when verification is required but cannot pass — no verifier
 * configured, no signature present, or a bad/expired/revoked/uncheckable
 * verdict. A `good` or `unknown` (valid but untrusted) verdict passes,
 * mirroring git's acceptance set. Returns `null` when nothing blocks.
 */
/**
 * GitRepo-shaped core of {@link requireVerifiedCommit}: resolve the verify
 * policy from a materialized {@link ConfigView}, then read the commit from the
 * object store and run the operator verifier. No fs path needed.
 */
export async function requireVerifiedCommitFrom(
	repo: GitRepo,
	config: ConfigView,
	commitHash: ObjectId,
	cliVerify: boolean | undefined,
	configKey: string,
): Promise<CommandResult | null> {
	const verify = cliVerify ?? configBool(config.get(configKey)) ?? false;
	if (!verify) return null;
	const verifier = repo.capabilities?.signing?.verifier;
	if (!verifier) return fatal("no signature verifier configured");
	const commit = await readCommit(repo, commitHash);
	// git identifies the commit by its abbreviated (7-char) hash in these messages.
	const short = abbreviateHash(commitHash);
	if (commit.gpgsig === undefined) {
		return fatal(`Commit ${short} does not have a GPG signature.`);
	}
	const result = await verifier(
		commitSigningPayload(commit),
		commit.gpgsig,
		await resolveVerifierOpts(repo),
	);
	if (result.status !== "good" && result.status !== "unknown") {
		return fatal(`Commit ${short} has a ${result.status} GPG signature.`);
	}
	return null;
}

export async function requireVerifiedCommit(
	gitCtx: GitContext,
	commitHash: ObjectId,
	cliVerify: boolean | undefined,
	configKey: string,
): Promise<CommandResult | null> {
	return requireVerifiedCommitFrom(
		gitCtx,
		await readConfigView(gitCtx),
		commitHash,
		cliVerify,
		configKey,
	);
}

/**
 * Clean up a commit message matching git's `strbuf_stripspace` with
 * comment stripping (the default `--cleanup=strip` mode):
 * - Remove lines starting with `#`
 * - Trim trailing whitespace from each line
 * - Strip leading and trailing blank lines
 * - Collapse consecutive blank lines into one
 *
 * Returns `""` when the cleaned message is empty.
 */
export function stripCommentLines(text: string): string {
	const lines = text
		.split("\n")
		.filter((line) => !line.startsWith("#"))
		.map((line) => line.trimEnd());

	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	if (lines.length === 0) return "";

	const result: string[] = [];
	let prevBlank = false;
	for (const line of lines) {
		if (line === "") {
			if (!prevBlank) result.push(line);
			prevBlank = true;
		} else {
			result.push(line);
			prevBlank = false;
		}
	}

	return result.join("\n") + "\n";
}

/** Ensure a commit message ends with exactly one newline. */
export function ensureTrailingNewline(msg: string): string {
	return msg.endsWith("\n") ? msg : `${msg}\n`;
}

// ── Transfer output formatting (fetch / push / pull) ────────────────

export interface TransferRefLine {
	prefix: string;
	from: string;
	to: string;
	suffix?: string;
}

/**
 * Format aligned ref-update lines for fetch/push/pull output.
 * Matches real git's columnar alignment: fixed-width summary column,
 * right-padded "from" ref, ` -> to` with optional suffix.
 *
 * Fetch/pull pads the "from" column to align arrows; push does not.
 */
export function formatTransferRefLines(
	lines: TransferRefLine[],
	minRefCol = 0,
	padFrom = true,
): string {
	const SUMMARY_WIDTH = 21;
	const maxFromLen = padFrom ? Math.max(minRefCol, ...lines.map((l) => l.from.length)) : 0;
	return lines
		.map((l) => {
			const summary = l.prefix.padEnd(SUMMARY_WIDTH);
			if (!l.to) return `${summary}${l.from}\n`;
			const from = maxFromLen > 0 ? l.from.padEnd(maxFromLen) : l.from;
			const suffix = l.suffix ? ` ${l.suffix}` : "";
			return `${summary}${from} -> ${l.to}${suffix}\n`;
		})
		.join("");
}

/**
 * Build TransferRefLines from a set of ref updates (shared by fetch and pull).
 * Each update carries the remote ref, the local tracking ref, and the
 * old hash (null when the tracking ref didn't exist before).
 */
export function buildRefUpdateLines(
	updates: Array<{
		remote: { name: string; hash: string };
		localRef: string;
		oldHash: string | null;
	}>,
	shortenRef: (name: string) => string,
	abbreviateHashFn: (hash: string) => string,
): TransferRefLine[] {
	const lines: TransferRefLine[] = [];
	for (const u of updates) {
		const shortRemote = shortenRef(u.remote.name);
		const shortLocal = shortenRef(u.localRef);
		if (!u.oldHash) {
			const isTag = u.remote.name.startsWith("refs/tags/");
			const prefix = isTag ? " * [new tag]" : " * [new branch]";
			lines.push({ prefix, from: shortRemote, to: shortLocal });
		} else if (u.oldHash !== u.remote.hash) {
			const shortOld = abbreviateHashFn(u.oldHash);
			const shortNew = abbreviateHashFn(u.remote.hash);
			lines.push({ prefix: `   ${shortOld}..${shortNew}`, from: shortRemote, to: shortLocal });
		}
	}
	return lines;
}
