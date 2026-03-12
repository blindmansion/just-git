import type { FileSystem } from "../fs.ts";
import type { GitExtensions } from "../git.ts";
import { getAuthor, getCommitter } from "./identity.ts";
import { hasConflicts, readIndex, writeIndex } from "./index.ts";
import { peelToCommit, readCommit, writeObject } from "./object-db.ts";
import { serializeCommit } from "./objects/commit.ts";
import { relative } from "./path.ts";
import { logRef } from "./reflog.ts";
import { advanceBranchRef, readHead, resolveHead, resolveRef } from "./refs.ts";
import { findGitDir } from "./repo.ts";
import { resolveRevision } from "./rev-parse.ts";
import type { Commit, GitContext, Identity, Index, ObjectId } from "./types.ts";
import { applyWorktreeOps, mergeAbort } from "./unpack-trees.ts";

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export function fatal(msg: string): CommandResult {
	return { stdout: "", stderr: `fatal: ${msg}\n`, exitCode: 128 };
}

export function err(msg: string, code = 1): CommandResult {
	return { stdout: "", stderr: msg, exitCode: code };
}

const NOT_A_GIT_REPO = fatal("not a git repository (or any of the parent directories): .git");

const NOT_A_WORK_TREE = fatal("this operation must be run in a work tree");

/**
 * Resolve the git context for the current working directory.
 * Returns either a GitContext or a pre-built error result for
 * "not a git repository".
 *
 * When `ext` is provided, the returned GitContext carries operator-level
 * extensions (hooks, credential provider, identity override).
 */
export async function requireGitContext(
	fs: FileSystem,
	cwd: string,
	ext?: GitExtensions,
): Promise<GitContext | CommandResult> {
	const ctx = await findGitDir(fs, cwd);
	if (!ctx) return NOT_A_GIT_REPO;
	if (!ext) return ctx;
	return { ...ctx, ...ext };
}

export function isCommandError<T>(result: T | CommandResult): result is CommandResult {
	return typeof result === "object" && result !== null && "exitCode" in (result as object);
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
export async function requireHead(gitCtx: GitContext): Promise<ObjectId | CommandResult> {
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
 * Resolve the committer identity, returning a CommandResult on failure.
 * Use with `isCommandError()` to check the result.
 */
export async function requireCommitter(
	ctx: GitContext,
	env: Map<string, string>,
): Promise<Identity | CommandResult> {
	try {
		return await getCommitter(ctx, env);
	} catch (e) {
		return fatal((e as Error).message);
	}
}

/**
 * Resolve the author identity, returning a CommandResult on failure.
 * Use with `isCommandError()` to check the result.
 */
export async function requireAuthor(
	ctx: GitContext,
	env: Map<string, string>,
): Promise<Identity | CommandResult> {
	try {
		return await getAuthor(ctx, env);
	} catch (e) {
		return fatal((e as Error).message);
	}
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

/** Standard path comparator for sorting entries by path. */
export function comparePaths(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** Compute the working-directory-relative prefix for pathspec resolution. */
export function getCwdPrefix(gitCtx: GitContext, cwd: string): string {
	return gitCtx.workTree ? relative(gitCtx.workTree, cwd) : "";
}

export function abbreviateHash(hash: ObjectId): string {
	return hash.slice(0, 7);
}

/** Extract the first line (subject) of a commit message. */
export function firstLine(message: string): string {
	const idx = message.indexOf("\n");
	return idx === -1 ? message : message.slice(0, idx);
}

/** Standard "ambiguous argument" error for unknown revisions/paths. */
export function ambiguousArgError(rev: string): CommandResult {
	return fatal(
		`ambiguous argument '${rev}': unknown revision or path not in the working tree.\n` +
			"Use '--' to separate paths from revisions, like this:\n" +
			"'git <command> [<revision>...] -- [<file>...]'",
	);
}

/**
 * Format the one-line commit header: `[branchName shortHash] firstLine`
 */
export function formatCommitOneLiner(
	branchName: string,
	hash: ObjectId,
	message: string,
	rootCommit = false,
): string {
	const rootLabel = rootCommit ? " (root-commit)" : "";
	return `[${branchName}${rootLabel} ${abbreviateHash(hash)}] ${firstLine(message)}`;
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

	const origHead = await resolveRef(gitCtx, "ORIG_HEAD");
	if (!origHead) {
		return fatal(`There is no ${opts.operationName} to abort (ORIG_HEAD missing).`);
	}

	const headBeforeAbort = await resolveHead(gitCtx);
	const origCommit = await readCommit(gitCtx, origHead);
	const currentIndex = await readIndex(gitCtx);

	const abortResult = await mergeAbort(
		gitCtx,
		origCommit.tree,
		currentIndex,
		opts.origHeadAsTargetRev ? origHead : undefined,
	);
	if (!abortResult.success) {
		return abortResult.errorOutput as CommandResult;
	}

	await advanceBranchRef(gitCtx, origHead);
	await writeIndex(gitCtx, { version: 2, entries: abortResult.newEntries });
	await applyWorktreeOps(gitCtx, abortResult.worktreeOps);

	if (headBeforeAbort) {
		const head = await readHead(gitCtx);
		const isOnBranch = head?.type === "symbolic";
		if (isOnBranch || headBeforeAbort !== origHead) {
			const resetTarget = opts.origHeadAsTargetRev ? origHead : "HEAD";
			await logRef(
				gitCtx,
				env,
				"HEAD",
				headBeforeAbort,
				origHead,
				`reset: moving to ${resetTarget}`,
			);
		}
	}

	await opts.clearState(gitCtx);

	return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Serialize a commit, write it to the object store, and advance the branch ref.
 * Returns the new commit hash.
 */
export async function writeCommitAndAdvance(
	ctx: GitContext,
	tree: ObjectId,
	parents: ObjectId[],
	author: Identity,
	committer: Identity,
	message: string,
): Promise<ObjectId> {
	const content = serializeCommit({
		type: "commit",
		tree,
		parents,
		author,
		committer,
		message,
	});
	const hash = await writeObject(ctx, "commit", content);
	await advanceBranchRef(ctx, hash);
	return hash;
}

/** Strip lines starting with `#` from MERGE_MSG / commit message text. */
export function stripCommentLines(text: string): string {
	return text
		.split("\n")
		.filter((line) => !line.startsWith("#"))
		.join("\n")
		.replace(/\n+$/, "\n");
}

/** Ensure a commit message ends with exactly one newline. */
export function ensureTrailingNewline(msg: string): string {
	return msg.endsWith("\n") ? msg : `${msg}\n`;
}
