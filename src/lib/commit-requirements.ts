// Command precondition guards and the shared commit-write chokepoint. Each
// `require*` helper resolves a piece of context (repo, work tree, HEAD,
// revision, identity, signature) and returns either the value or a
// `CommandResult` error for the caller to short-circuit on (detect with
// `isCommandError`).

import type { FileSystem } from "../fs.ts";
import type { GitExtensions } from "../git.ts";
import { abbreviateHash } from "./abbrev.ts";
import { withCapabilities } from "./capabilities.ts";
import { type CommandResult, err, fatal } from "./command-errors.ts";
import { configBool, readConfigView } from "./config.ts";
import { resolveIdentityFrom } from "./identity.ts";
import { hasConflicts } from "./index.ts";
import { peelToCommit, readCommit, writeObject } from "./object-db.ts";
import { serializeCommit } from "./objects/commit.ts";
import { advanceBranchRef, resolveHead } from "./refs.ts";
import { findRepo } from "./repo.ts";
import { resolveRevision } from "./rev-parse.ts";
import { type Signer, commitSigningPayload, resolveVerifierOpts } from "./signing.ts";
import type {
	Commit,
	ConfigView,
	GitContext,
	GitRepo,
	Identity,
	Index,
	ObjectId,
} from "./types.ts";

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
