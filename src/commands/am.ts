import type { CommandContext, GitExtensions } from "../git.ts";
import {
	type AmState,
	clearAmState,
	isAmInProgress,
	patchFileName,
	readAmState,
	readAmStopMeta,
	readPatchMessage,
	setAmNext,
	writeAmState,
	writeAmStopMeta,
} from "../lib/am.ts";
import { writeCommitAndAdvance } from "../lib/commit-write.ts";
import { getStage0Entries, hasConflicts, readIndex, writeIndex } from "../lib/index.ts";
import { readCommit } from "../lib/object-db.ts";
import { type ApplyResult, applyPatches } from "../lib/patch/apply.ts";
import { appendSignoff } from "../lib/patch/mbox.ts";
import { parseMail, splitMailbox } from "../lib/patch/mailinfo.ts";
import { ApplyParseError, parsePatch } from "../lib/patch/parse-patch.ts";
import { resolve } from "../lib/path.ts";
import { logRef } from "../lib/refs/reflog.ts";
import { advanceBranchRef, readHead, resolveHead } from "../lib/refs/refs.ts";
import { firstLine } from "../lib/text-utils.ts";
import { buildTreeFromIndex, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitContext, Identity, Index } from "../lib/types.ts";
import { applyWorktreeOps, fastForwardMerge } from "../lib/worktree/unpack-trees.ts";
import { type CommandResult, err, fatal, isCommandError } from "./kit/command-result.ts";
import { resolveCommandSigner } from "./kit/command-utils.ts";
import { requireCommitter, requireGitContext } from "./kit/commit-requirements.ts";
import { a, type Command, f, o } from "./kit/parse/index.ts";

/** Decode a possibly-byte-encoded stdin payload into text (see apply.ts). */
function stdinToText(stdin: CommandContext["stdin"]): string {
	const raw = stdin as string;
	if (typeof raw !== "string") return "";
	for (let i = 0; i < raw.length; i++) {
		if (raw.charCodeAt(i) > 255) return raw;
	}
	const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return raw;
	}
}

/**
 * The resolve-hint block git prints when it pauses for the user (git's
 * `die_user_resolve`). The initial apply-fail stop prepends the
 * `--show-current-patch` advice; a `--continue` that still sees a problem
 * prints only this block.
 */
const DIE_USER_RESOLVE =
	'hint: When you have resolved this problem, run "git am --continue".\n' +
	'hint: If you prefer to skip this patch, run "git am --skip" instead.\n' +
	'hint: To restore the original branch and stop patching, run "git am --abort".\n' +
	'hint: Disable this message with "git config set advice.mergeConflict false"\n';

/** The hint block emitted under a fresh apply-fail stop. */
const RESOLVE_HINT =
	"hint: Use 'git am --show-current-patch=diff' to see the failed patch\n" + DIE_USER_RESOLVE;

/**
 * The resolve-hint block git prints when it pauses on an empty patch: like
 * `die_user_resolve` but with the extra `--allow-empty` advice and without the
 * `--show-current-patch` line (git's parse_mail empty-patch path).
 */
const EMPTY_RESOLVE_HINT =
	'hint: When you have resolved this problem, run "git am --continue".\n' +
	'hint: If you prefer to skip this patch, run "git am --skip" instead.\n' +
	'hint: To record the empty patch as an empty commit, run "git am --allow-empty".\n' +
	'hint: To restore the original branch and stop patching, run "git am --abort".\n' +
	'hint: Disable this message with "git config set advice.mergeConflict false"\n';

/** git's "Resolve operation not in progress" — a resume verb with no session. */
function notResuming(): CommandResult {
	return fatal("Resolve operation not in progress, we are not resuming.");
}

/** Assemble the commit message from a parsed mail + signoff option. */
function buildMessage(subject: string, body: string, signoffLine: string | null): string {
	const finalBody = signoffLine ? appendSignoff(subject, body, signoffLine) : body;
	return finalBody === "" ? `${subject}\n` : `${subject}\n\n${finalBody}\n`;
}

/**
 * git's `repo_index_has_changes` guard, run by `am_run` before the first
 * apply: `git am` refuses to start on an index that differs from HEAD. Returns
 * the stop result when dirty, or null when the index matches HEAD.
 *
 * Mirrors git's diff-cache: each unmerged path emits a `<path>: needs merge`
 * line on stdout, and every path that differs from HEAD — a staged add/modify/
 * delete or a conflict — is listed, path-sorted, in the fatal's `(dirty: …)`.
 */
async function checkDirtyIndex(gitCtx: GitContext, index: Index): Promise<CommandResult | null> {
	const headHash = await resolveHead(gitCtx);
	const headMap = headHash
		? await flattenTreeToMap(gitCtx, (await readCommit(gitCtx, headHash)).tree)
		: new Map<string, { hash: string }>();

	const stage0 = new Map<string, string>();
	const allPaths = new Set<string>();
	const unmerged = new Set<string>();
	for (const e of index.entries) {
		allPaths.add(e.path);
		if (e.stage === 0) stage0.set(e.path, e.hash);
		else unmerged.add(e.path);
	}

	const dirty = new Set<string>(unmerged);
	for (const [path, hash] of stage0) {
		const head = headMap.get(path);
		if (!head || head.hash !== hash) dirty.add(path);
	}
	for (const path of headMap.keys()) {
		if (!allPaths.has(path)) dirty.add(path);
	}

	if (dirty.size === 0) return null;

	const needsMerge = [...unmerged].sort();
	const dirtyList = [...dirty].sort();
	return {
		stdout: needsMerge.map((p) => `${p}: needs merge\n`).join(""),
		stderr: `fatal: Dirty index: cannot apply patches (dirty: ${dirtyList.join(" ")})\n`,
		exitCode: 128,
	};
}

export function registerAmCommand(parent: Command, ext?: GitExtensions): void {
	parent.command("am", {
		description: "Apply a series of patches from a mailbox",
		// `--show-current-patch` takes an optional `=raw|diff` value; the parser
		// treats a bare value-option as consuming the next token, so rewrite the
		// bare form to its default (`=raw`) before parsing.
		transformArgs: (tokens) =>
			tokens.map((t) => (t === "--show-current-patch" ? "--show-current-patch=raw" : t)),
		args: [a.string().name("mbox").variadic().optional()],
		options: {
			"3way": f().alias("3").describe("Use a 3-way merge if the patch does not apply cleanly"),
			signoff: f().alias("s").describe("Add a Signed-off-by trailer to the commit message"),
			quiet: f().alias("q").describe("Suppress the 'Applying:' progress output"),
			keep: f().alias("k").describe("Pass the subject through verbatim (keep [PATCH])"),
			scissors: f().describe("Cut everything above a scissors line before the body"),
			keepCr: f().describe("Keep a trailing CR on body/patch lines"),
			committerDateIsAuthorDate: f().describe("Use the author date as the committer date"),
			continue: f().alias("c").describe("Continue after resolving a failed patch"),
			skip: f().describe("Skip the current patch"),
			abort: f().describe("Restore the original branch and abort the patching"),
			quit: f().describe("Abort the patching but keep HEAD where it is"),
			showCurrentPatch: o
				.string()
				.describe("Show the patch being applied (raw|diff); defaults to raw"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── Resume verbs (all require a session in progress) ──────
			const inProgress = await isAmInProgress(gitCtx);
			const showPatch = args.showCurrentPatch as string | undefined;
			if (args.continue || args.skip || args.abort || args.quit || showPatch !== undefined) {
				if (!inProgress) return notResuming();
				if (showPatch !== undefined) return handleShowCurrentPatch(gitCtx, showPatch);
				if (args.abort) return handleAbort(gitCtx, ctx.env);
				if (args.quit) return handleQuit(gitCtx);
				if (args.skip) return handleSkip(gitCtx, ctx.env);
				return handleContinue(gitCtx, ctx.env);
			}

			// ── Start mode ────────────────────────────────────────────
			if (inProgress) {
				return err(
					"error: previous rebase directory .git/rebase-apply still exists but mbox given.\n",
					128,
				);
			}

			// Gather input (file args, else stdin).
			const files = (args.mbox as string[] | undefined) ?? [];
			let text: string;
			if (files.length > 0) {
				const parts: string[] = [];
				for (const file of files) {
					const full = resolve(ctx.cwd, file);
					if (!(await ctx.fs.exists(full))) {
						return fatal(`cannot open ${file}: No such file or directory`);
					}
					parts.push(new TextDecoder().decode(await ctx.fs.readFileBuffer(full)));
				}
				text = parts.join("");
			} else {
				text = stdinToText(ctx.stdin);
			}
			if (text.trim() === "") {
				return fatal("No input file given and no patches in stdin");
			}

			const index = await readIndex(gitCtx);

			// Split the mailbox, write the state dir, run the loop.
			const messages = splitMailbox(text);
			if (messages.length === 0) {
				return err("Patch format detection failed.\n", 128);
			}

			const origHead = (await resolveHead(gitCtx)) ?? "";
			const state: AmState = {
				next: 1,
				last: messages.length,
				threeway: !!args["3way"],
				sign: !!args.signoff,
				keep: !!args.keep,
				scissors: !!args.scissors,
				quiet: !!args.quiet,
				keepCr: !!args.keepCr,
				committerDateIsAuthorDate: !!args.committerDateIsAuthorDate,
				origHead,
			};
			await writeAmState(gitCtx, state, messages);

			// git's `am_run` refuses to apply onto a dirty index (index ≠ HEAD)
			// *after* `am_setup` has created the state dir — so the aborted
			// session is left resumable/abortable (operation stays "rebase"),
			// matching real git rather than bailing before any state is written.
			const dirty = await checkDirtyIndex(gitCtx, index);
			if (dirty) return dirty;

			return runAmLoop(gitCtx, ctx.env);
		},
	});
}

/**
 * Snapshot the current index into a tree and write the commit, advancing HEAD
 * and logging the reflog. Shared by the driver loop and `--continue`.
 */
async function writeAmCommit(
	gitCtx: GitContext,
	env: Map<string, string>,
	author: Identity,
	committer: Identity,
	message: string,
): Promise<CommandResult | null> {
	const headHash = await resolveHead(gitCtx);
	const freshIndex = await readIndex(gitCtx);
	const tree = await buildTreeFromIndex(gitCtx, getStage0Entries(freshIndex));

	const signer = await resolveCommandSigner(gitCtx, undefined, "commit.gpgsign");
	if (isCommandError(signer)) return signer;

	const commitHash = await writeCommitAndAdvance(
		gitCtx,
		tree,
		headHash ? [headHash] : [],
		author,
		committer,
		message,
		signer,
	);

	const head = await readHead(gitCtx);
	const refName = head?.type === "symbolic" ? head.target : "HEAD";
	await logRef(
		gitCtx,
		env,
		refName,
		headHash,
		commitHash,
		`am: ${firstLine(message)}`,
		head?.type === "symbolic",
	);
	return null;
}

/**
 * Build the `CommandResult` for a stop: git emits the progress and
 * `Patch failed at` on stdout, the `error:` diagnostics + resolve hint on
 * stderr, and exits 128 — leaving the state dir for `--continue`/`--abort`.
 */
function renderStop(
	stdoutPrefix: string,
	result: ApplyResult,
	patchName: string,
	subject: string,
	threeway: boolean,
): CommandResult {
	const outLines: string[] = [stdoutPrefix];
	const errLines: string[] = [];

	if (threeway) {
		outLines.push("Using index info to reconstruct a base tree...\n");
		outLines.push("Falling back to patching base and 3-way merge...\n");
		for (const file of result.files) {
			if (file.threeway?.kind === "conflict") {
				outLines.push(`Auto-merging ${file.path}\n`);
				outLines.push(`CONFLICT (content): Merge conflict in ${file.path}\n`);
			}
		}
		errLines.push("error: Failed to merge in the changes.\n");
	} else {
		for (const e of result.errors) errLines.push(`error: ${e}\n`);
	}

	outLines.push(`Patch failed at ${patchName} ${subject}\n`);
	errLines.push(RESOLVE_HINT);

	return { stdout: outLines.join(""), stderr: errLines.join(""), exitCode: 128 };
}

/**
 * The core apply-and-commit loop, driven by the on-disk `next`/`last` counters.
 * Applies each patch to the index + worktree and writes a commit; stops and
 * leaves the state dir on the first patch that fails to apply.
 */
async function runAmLoop(gitCtx: GitContext, env: Map<string, string>): Promise<CommandResult> {
	const out: string[] = [];

	for (;;) {
		const state = await readAmState(gitCtx);
		if (!state) break;
		if (state.next > state.last) {
			await clearAmState(gitCtx);
			break;
		}

		const raw = await readPatchMessage(gitCtx, state.next);
		const mail = parseMail(raw, {
			keep: state.keep,
			scissors: state.scissors,
			keepCr: state.keepCr,
		});
		const patchName = patchFileName(state.next);

		// An empty patch pauses the session *before* the "Applying:" line
		// (git's parse_mail): print "Patch is empty." and stop with the
		// empty-patch resolve hints, leaving the state dir in place so the
		// session is resumable (`--continue`/`--allow-empty`/`--skip`/`--abort`).
		if (mail.patchText.trim() === "") {
			return {
				stdout: `${out.join("")}Patch is empty.\n`,
				stderr: EMPTY_RESOLVE_HINT,
				exitCode: 128,
			};
		}

		if (!state.quiet) out.push(`Applying: ${mail.subject}\n`);

		// Resolve the committer up front so the stored message (with signoff)
		// is available on every stop path.
		const committer = await requireCommitter(gitCtx, env);
		if (isCommandError(committer)) return committer;
		const signoffLine = state.sign ? `Signed-off-by: ${committer.name} <${committer.email}>` : null;
		const message = buildMessage(mail.subject, mail.body, signoffLine);

		let patches;
		try {
			patches = parsePatch(mail.patchText);
		} catch (e) {
			if (e instanceof ApplyParseError) {
				await writeAmStopMeta(gitCtx, message, mail.author);
				return {
					stdout: `${out.join("")}Patch failed at ${patchName} ${mail.subject}\n`,
					stderr: `error: corrupt patch at line ${e.line}\n${RESOLVE_HINT}`,
					exitCode: 128,
				};
			}
			throw e;
		}

		// Apply to the index + worktree.
		const result = await applyPatches(gitCtx, patches, {
			reverse: false,
			target: "index",
			whitespace: "warn",
			unidiffZero: false,
			reject: false,
			threeway: state.threeway,
			check: false,
		});

		if (!result.ok) {
			// Stop, leaving the state dir for a later --continue / --abort.
			await writeAmStopMeta(gitCtx, message, mail.author);
			return renderStop(out.join(""), result, patchName, mail.subject, state.threeway);
		}

		// Success: commit the snapshotted index.
		const committerId: Identity = state.committerDateIsAuthorDate
			? { ...committer, timestamp: mail.author.timestamp, timezone: mail.author.timezone }
			: committer;

		const commitErr = await writeAmCommit(gitCtx, env, mail.author, committerId, message);
		if (commitErr) return commitErr;

		await setAmNext(gitCtx, state.next + 1);
	}

	return { stdout: out.join(""), stderr: "", exitCode: 0 };
}

// ── Resume verbs ────────────────────────────────────────────────────

/**
 * `--continue`: commit the paused patch from the saved `author-script` +
 * `final-commit`, then resume the loop. Refuses when the index still has
 * unmerged entries or nothing was staged (git's `am_resolve`).
 */
async function handleContinue(
	gitCtx: GitContext,
	env: Map<string, string>,
): Promise<CommandResult> {
	const state = await readAmState(gitCtx);
	if (!state) return notResuming();
	const meta = await readAmStopMeta(gitCtx);
	if (!meta) {
		// git's `am_load` reads `final-commit` before the author script, so a
		// resume with no stop metadata (e.g. after a dirty-index death) reports
		// the missing `final-commit` first.
		return fatal("cannot resume: .git/rebase-apply/final-commit does not exist.");
	}

	const out: string[] = [];
	const subject = firstLine(meta.message);
	if (!state.quiet) out.push(`Applying: ${subject}\n`);

	const index = await readIndex(gitCtx);
	if (hasConflicts(index)) {
		return {
			stdout:
				`${out.join("")}You still have unmerged paths in your index.\n` +
				"You should 'git add' each file with resolved conflicts to mark them as such.\n" +
				'You might run `git rm` on a file to accept "deleted by them" for it.\n',
			stderr: DIE_USER_RESOLVE,
			exitCode: 128,
		};
	}

	const headHash = await resolveHead(gitCtx);
	const indexTree = await buildTreeFromIndex(gitCtx, getStage0Entries(index));
	const headTree = headHash
		? (await readCommit(gitCtx, headHash)).tree
		: await buildTreeFromIndex(gitCtx, []);
	if (indexTree === headTree) {
		return {
			stdout:
				`${out.join("")}No changes - did you forget to use 'git add'?\n` +
				"If there is nothing left to stage, chances are that something else\n" +
				"already introduced the same changes; you might want to skip this patch.\n",
			stderr: DIE_USER_RESOLVE,
			exitCode: 128,
		};
	}

	const committer = await requireCommitter(gitCtx, env);
	if (isCommandError(committer)) return committer;
	const committerId: Identity = state.committerDateIsAuthorDate
		? { ...committer, timestamp: meta.author.timestamp, timezone: meta.author.timezone }
		: committer;

	const commitErr = await writeAmCommit(gitCtx, env, meta.author, committerId, meta.message);
	if (commitErr) return commitErr;
	await setAmNext(gitCtx, state.next + 1);

	const rest = await runAmLoop(gitCtx, env);
	return {
		stdout: out.join("") + rest.stdout,
		stderr: rest.stderr,
		exitCode: rest.exitCode,
	};
}

/**
 * `--skip`: reset the index + worktree back to HEAD (discarding the paused
 * patch's partial work), advance past it, and resume the loop.
 */
async function handleSkip(gitCtx: GitContext, env: Map<string, string>): Promise<CommandResult> {
	const state = await readAmState(gitCtx);
	if (!state) return notResuming();

	const headHash = await resolveHead(gitCtx);
	if (headHash) {
		const headTree = (await readCommit(gitCtx, headHash)).tree;
		const index = await readIndex(gitCtx);
		// git's `am --skip` runs `clean_index` — a two-way merge from the
		// current index tree back to HEAD, NOT a hard reset: the half-applied
		// patch's staged changes are dropped, but unrelated local worktree
		// modifications are preserved (twoway_merge leaves untouched any path
		// whose index and HEAD entries already agree).
		const indexTree = await buildTreeFromIndex(gitCtx, getStage0Entries(index));
		const reset = await fastForwardMerge(gitCtx, indexTree, headTree, index);
		if (reset.success) {
			await writeIndex(gitCtx, { version: 2, entries: reset.newEntries });
			await applyWorktreeOps(gitCtx, reset.worktreeOps);
		}
	}

	await setAmNext(gitCtx, state.next + 1);
	return runAmLoop(gitCtx, env);
}

/**
 * `--abort`: restore the pre-`am` HEAD (`orig-head`), reset the index +
 * worktree to it, and clear the state dir.
 */
async function handleAbort(gitCtx: GitContext, env: Map<string, string>): Promise<CommandResult> {
	const state = await readAmState(gitCtx);
	if (!state) return notResuming();

	if (state.origHead) {
		const headBeforeAbort = await resolveHead(gitCtx);
		const index = await readIndex(gitCtx);
		// git's `am --abort` unwinds via `checkout_fast_forward` (a two-way
		// merge from the current HEAD to orig-head), NOT a hard reset: any
		// uncommitted worktree changes present before the `am` are preserved.
		// When no patches applied (HEAD == orig-head) this is a no-op on the
		// worktree, leaving local modifications intact — matching real git.
		const currentTree = headBeforeAbort
			? (await readCommit(gitCtx, headBeforeAbort)).tree
			: await buildTreeFromIndex(gitCtx, []);
		const origTree = (await readCommit(gitCtx, state.origHead)).tree;
		const reset = await fastForwardMerge(gitCtx, currentTree, origTree, index);
		if (reset.success) {
			await writeIndex(gitCtx, { version: 2, entries: reset.newEntries });
			await applyWorktreeOps(gitCtx, reset.worktreeOps);
		}
		await advanceBranchRef(gitCtx, state.origHead);
		const head = await readHead(gitCtx);
		if (head?.type === "symbolic") {
			await logRef(
				gitCtx,
				env,
				"HEAD",
				headBeforeAbort,
				state.origHead,
				`reset: moving to ${state.origHead}`,
				true,
			);
		}
	}

	await clearAmState(gitCtx);
	return { stdout: "", stderr: "", exitCode: 0 };
}

/** `--quit`: drop the state dir but leave HEAD / index / worktree untouched. */
async function handleQuit(gitCtx: GitContext): Promise<CommandResult> {
	const state = await readAmState(gitCtx);
	if (!state) return notResuming();
	await clearAmState(gitCtx);
	return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * `--show-current-patch[=raw|diff]`: print the paused message (`raw`, the whole
 * stored `NNNN` file) or just its diff tail (`diff`).
 */
async function handleShowCurrentPatch(gitCtx: GitContext, mode: string): Promise<CommandResult> {
	const state = await readAmState(gitCtx);
	if (!state) return notResuming();
	const raw = await readPatchMessage(gitCtx, state.next);
	if (mode === "diff") {
		const mail = parseMail(raw, {
			keep: state.keep,
			scissors: state.scissors,
			keepCr: state.keepCr,
		});
		const patch = mail.patchText.endsWith("\n") ? mail.patchText : `${mail.patchText}\n`;
		return { stdout: patch, stderr: "", exitCode: 0 };
	}
	return { stdout: raw, stderr: "", exitCode: 0 };
}
