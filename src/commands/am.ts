import type { CommandContext, GitExtensions } from "../git.ts";
import {
	type AmState,
	clearAmState,
	clearDirtyIndex,
	hasDirtyIndex,
	isAmInProgress,
	patchFileName,
	readAbortSafety,
	setDirtyIndex,
	readAmState,
	readAmStopMeta,
	readPatchMessage,
	refreshAbortSafety,
	setAmNext,
	writeAmState,
	writeAmStopMeta,
} from "../lib/am.ts";
import { bindAttributes } from "../lib/attributes/bound-attributes.ts";
import { writeCommitAndAdvance } from "../lib/commit-write.ts";
import { getConfigValue } from "../lib/config/store.ts";
import {
	defaultStat,
	getStage0Entries,
	hasConflicts,
	readIndex,
	writeIndex,
} from "../lib/index.ts";
import { type ApplyMergeFailure, applyMergeResult } from "../lib/merge-ort.ts";
import { readCommit } from "../lib/object-db.ts";
import { type ApplyResult, applyPatches } from "../lib/patch/apply.ts";
import { appendSignoff } from "../lib/patch/mbox.ts";
import { parseMail, splitMailbox } from "../lib/patch/mailinfo.ts";
import { ApplyParseError, type ParsedPatch, parsePatch } from "../lib/patch/parse-patch.ts";
import { resolve } from "../lib/path.ts";
import { logRef } from "../lib/refs/reflog.ts";
import {
	advanceBranchRef,
	deleteRef,
	readHead,
	resolveHead,
	resolveRef,
	updateRef,
} from "../lib/refs/refs.ts";
import { firstLine } from "../lib/text-utils.ts";
import { buildTreeFromIndex, flattenTreeToMap } from "../lib/tree-ops.ts";
import type { GitContext, Identity, Index, ObjectId } from "../lib/types.ts";
import {
	applyWorktreeOps,
	onewayMerge,
	type RejectedPath,
	twowayMerge,
	UnpackError,
	unpackTrees,
} from "../lib/worktree/unpack-trees.ts";
import { fallBackThreeway } from "../repo/patching.ts";
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

			const origHead = await resolveHead(gitCtx);
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
			};
			await writeAmState(gitCtx, state, messages);

			// git's `am_setup` records the pre-`am` HEAD in the `ORIG_HEAD` ref
			// (not a state-dir file) and seeds `abort-safety` with it. `--abort`
			// later reads `ORIG_HEAD`, so an intervening command that rewrites
			// `ORIG_HEAD` steers the abort target exactly as it does in git.
			if (origHead) await updateRef(gitCtx, "ORIG_HEAD", origHead);
			else await deleteRef(gitCtx, "ORIG_HEAD");
			await refreshAbortSafety(gitCtx, origHead);

			// git's `am_run` refuses to apply onto a dirty index (index ≠ HEAD)
			// *after* `am_setup` has created the state dir — so the aborted
			// session is left resumable/abortable (operation stays "rebase"),
			// matching real git rather than bailing before any state is written.
			// The `dirtyindex` marker it drops here later tells `--abort` to just
			// clean up (no rewind / warning), since HEAD was never moved.
			const dirty = await checkDirtyIndex(gitCtx, index);
			if (dirty) {
				await setDirtyIndex(gitCtx);
				return dirty;
			}

			return runAmLoop(gitCtx, ctx.env);
		},
	});
}

/**
 * git's `repo_index_has_changes(HEAD)` (negated): true when the current index's
 * stage-0 tree is identical to HEAD's tree, i.e. the staged state introduces no
 * net change. Used to detect the `-3` "Patch already applied" case.
 */
async function indexMatchesHead(gitCtx: GitContext): Promise<boolean> {
	const headHash = await resolveHead(gitCtx);
	const index = await readIndex(gitCtx);
	const indexTree = await buildTreeFromIndex(gitCtx, getStage0Entries(index));
	const headTree = headHash
		? (await readCommit(gitCtx, headHash)).tree
		: await buildTreeFromIndex(gitCtx, []);
	return indexTree === headTree;
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
	// git's `am_next` refreshes abort-safety to the current HEAD after each
	// committed patch, so `--abort`'s guard can tell whether HEAD later moved
	// out from under the paused session.
	await refreshAbortSafety(gitCtx, commitHash);
	return null;
}

/**
 * Build the `CommandResult` for a plain-apply stop: git emits the progress and
 * `Patch failed at` on stdout, the `error:` diagnostics + resolve hint on
 * stderr, and exits 128 — leaving the state dir for `--continue`/`--abort`.
 */
function renderStop(
	stdoutPrefix: string,
	result: ApplyResult,
	patchName: string,
	subject: string,
): CommandResult {
	const errLines = result.errors.map((e) => `error: ${e}\n`);
	errLines.push(RESOLVE_HINT);
	return {
		stdout: `${stdoutPrefix}Patch failed at ${patchName} ${subject}\n`,
		stderr: errLines.join(""),
		exitCode: 128,
	};
}

/**
 * git's unpack-trees "would be overwritten by merge" block, as `am` renders it:
 * the same file lists as `merge`/`cherry-pick` but *without* the ort/sequencer
 * trailer — `am` appends its own `error: Failed to merge in the changes.`
 * afterward (see {@link attemptThreeway}).
 */
function renderAmMergeGuard(failure: ApplyMergeFailure): string {
	const blocks: string[] = [];
	if (failure.localFiles.length > 0) {
		blocks.push(
			"error: Your local changes to the following files would be overwritten by merge:\n" +
				`${failure.localFiles.map((p) => `\t${p}`).join("\n")}\n` +
				"Please commit your changes or stash them before you merge.\n",
		);
	}
	if (failure.kind === "worktree" && failure.untrackedFiles.length > 0) {
		blocks.push(
			"error: The following untracked working tree files would be overwritten by merge:\n" +
				`${failure.untrackedFiles.map((p) => `\t${p}`).join("\n")}\n` +
				"Please move or remove them before you merge.\n",
		);
	}
	return `${blocks.join("")}Aborting\n`;
}

/**
 * git's `fall_back_threeway` for `am -3`: reconstruct a fake-ancestor tree from
 * the series' recorded base OIDs, apply the series onto it for "theirs", run a
 * real tree merge against HEAD, and write it out (with the dirty-worktree
 * overwrite guard). Returns a resumable `stop` (blob missing, patch would not
 * re-apply, worktree guard, or a merge conflict) or `clean` when the merge
 * resolved cleanly (the merged result is staged; the caller commits it).
 *
 * The `stdout` tail is everything git prints for this patch *before* the
 * `Patch failed at …` line (which the driver appends on a stop). Under `-q`
 * git suppresses the whole preamble and the merge messages.
 */
async function attemptThreeway(
	gitCtx: GitContext,
	patches: ParsedPatch[],
	subject: string,
	quiet: boolean,
	restored: string[],
): Promise<{ kind: "stop"; stdout: string; stderr: string } | { kind: "clean"; stdout: string }> {
	const index = await readIndex(gitCtx);
	const oursTree = await buildTreeFromIndex(gitCtx, getStage0Entries(index));
	const conflictStyle = ((await getConfigValue(gitCtx, "merge.conflictstyle")) ?? "merge") as
		| "merge"
		| "diff3";
	const labels = { a: "HEAD", b: subject, conflictStyle };
	const mergeDriver = (await bindAttributes(gitCtx, "am"))?.merge;

	const fb = await fallBackThreeway(gitCtx, patches, oursTree, labels, mergeDriver);

	if (fb.status === "no-base") {
		// git's build_fake_ancestor bailed before the "Using index info…" line.
		return {
			kind: "stop",
			stdout: "",
			stderr:
				`error: sha1 information is lacking or useless (${fb.missingPath}).\n` +
				`error: could not build fake ancestor\n${RESOLVE_HINT}`,
		};
	}
	if (fb.status === "apply-failed") {
		return {
			kind: "stop",
			stdout: "",
			stderr:
				"error: Did you hand edit your patch?\n" +
				`It does not apply to blobs recorded in its index.\n${RESOLVE_HINT}`,
		};
	}

	// The reconstruction preamble git prints before the merge write-out.
	const preamble = quiet
		? ""
		: "Using index info to reconstruct a base tree...\n" +
			fb.statusLines.map((l) => `${l}\n`).join("") +
			"Falling back to patching base and 3-way merge...\n";

	// Write the merge out: the dirty-worktree overwrite guard lives here. In
	// `am` the index always matches HEAD (dirty-index guard), so skip the
	// staged-change check and let only the worktree twoway check run.
	const applied = await applyMergeResult(gitCtx, fb.merge, oursTree, {
		labels,
		skipStagedChangeCheck: true,
		// The plain-apply pass checked out these missing-but-tracked preimage
		// files to the worktree; git still reports them as "would be overwritten
		// by merge" because they were not up-to-date when the merge began.
		forceDirtyPaths: restored.length > 0 ? new Set(restored) : undefined,
	});

	if (!applied.ok) {
		// git's merge_recursive refused at unpack-trees before any content merge,
		// so no "Auto-merging"/CONFLICT lines are emitted.
		return {
			kind: "stop",
			stdout: preamble,
			stderr: `${renderAmMergeGuard(applied)}error: Failed to merge in the changes.\n${RESOLVE_HINT}`,
		};
	}

	const mergeMessages = quiet ? "" : fb.merge.messages.map((m) => `${m}\n`).join("");

	if (fb.merge.conflicts.length > 0) {
		// Stages 1/2/3 + conflict-marker worktree files are already recorded.
		return {
			kind: "stop",
			stdout: `${preamble}${mergeMessages}`,
			stderr: `error: Failed to merge in the changes.\n${RESOLVE_HINT}`,
		};
	}

	return { kind: "clean", stdout: `${preamble}${mergeMessages}` };
}

/**
 * The core apply-and-commit loop, driven by the on-disk `next`/`last` counters.
 * Applies each patch to the index + worktree and writes a commit; stops and
 * leaves the state dir on the first patch that fails to apply.
 */
async function runAmLoop(gitCtx: GitContext, env: Map<string, string>): Promise<CommandResult> {
	const out: string[] = [];

	// git's `am_run` unlinks any `dirtyindex` marker before (re-)entering the
	// apply loop, so a session that recovered from a dirty-index death no longer
	// reports itself dirty to a later `--abort`.
	await clearDirtyIndex(gitCtx);

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

		// Resolve the committer up front so the stored message (with signoff)
		// is available on every stop path — including the empty-patch pause.
		const committer = await requireCommitter(gitCtx, env);
		if (isCommandError(committer)) return committer;
		const signoffLine = state.sign ? `Signed-off-by: ${committer.name} <${committer.email}>` : null;
		const message = buildMessage(mail.subject, mail.body, signoffLine);

		// An empty patch pauses the session *before* the "Applying:" line
		// (git's parse_mail): print "Patch is empty." and stop with the
		// empty-patch resolve hints. Persist the stop meta (`final-commit` +
		// `author-script`) like any other stop so the session is resumable —
		// `--continue` records the (resolved) commit under the stored author/
		// message, and `--skip`/`--abort` unwind it.
		if (mail.patchText.trim() === "") {
			await writeAmStopMeta(gitCtx, message, mail.author);
			return {
				stdout: `${out.join("")}Patch is empty.\n`,
				stderr: EMPTY_RESOLVE_HINT,
				exitCode: 128,
			};
		}

		if (!state.quiet) out.push(`Applying: ${mail.subject}\n`);

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

		// Plain apply to the index + worktree (git's initial `git apply`). Only
		// on failure — and only under `-3` — do we fall back to the tree-level
		// three-way merge (git's fall_back_threeway).
		const result = await applyPatches(gitCtx, patches, {
			reverse: false,
			target: "index",
			whitespace: "warn",
			unidiffZero: false,
			reject: false,
			threeway: false,
			check: false,
		});

		if (!result.ok) {
			if (!state.threeway) {
				await writeAmStopMeta(gitCtx, message, mail.author);
				return renderStop(out.join(""), result, patchName, mail.subject);
			}
			const tw = await attemptThreeway(gitCtx, patches, mail.subject, state.quiet, result.restored);
			if (tw.kind === "stop") {
				await writeAmStopMeta(gitCtx, message, mail.author);
				return {
					stdout: `${out.join("")}${tw.stdout}Patch failed at ${patchName} ${mail.subject}\n`,
					stderr: tw.stderr,
					exitCode: 128,
				};
			}
			// Clean tree merge — the merged result is staged; fall through and
			// commit it exactly like a plain-apply success.
			out.push(tw.stdout);

			// git's post-`fall_back_threeway` check: applying the patch to an
			// earlier tree and merging back may reproduce HEAD's tree exactly.
			// When the index no longer differs from HEAD, git prints "No changes
			// -- Patch already applied." (suppressed under `-q`) and skips the
			// commit, advancing to the next patch via `am_next`.
			if (await indexMatchesHead(gitCtx)) {
				if (!state.quiet) out.push("No changes -- Patch already applied.\n");
				await refreshAbortSafety(gitCtx, await resolveHead(gitCtx));
				await setAmNext(gitCtx, state.next + 1);
				continue;
			}
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

/**
 * git's `clean_index(head, remote)` (`builtin/am.c`), used by `--skip`
 * (`head == remote == HEAD`) and `--abort` (`head = HEAD`, `remote = ORIG_HEAD`):
 *
 *   1. Collapse conflicts back to `head` — resolve every unmerged path to its
 *      `head` blob in the index and worktree, leaving non-conflict index/
 *      worktree entries untouched (git's `read_index_unmerged` +
 *      `fast_forward_to(head, head, reset)`). This discards the failed patch's
 *      conflict artifacts.
 *   2. Two-way merge the resulting index tree → `remote`, preserving local
 *      worktree changes and *failing* (like git's `fast_forward_to(index,
 *      remote, 0)`) when a path that must change is not up to date.
 *   3. One-way merge `remote` into the index so it matches the `remote` tree
 *      exactly (git's `merge_tree(remote)`) — index only, no worktree update.
 *
 * Returns `{ ok: true }` on success, or the first rejected path so the caller
 * can render git's `failed to clean index` die.
 */
async function cleanIndex(
	gitCtx: GitContext,
	headTree: ObjectId,
	remoteTree: ObjectId,
): Promise<{ ok: true } | { ok: false; rejected: RejectedPath }> {
	// Step 1: resolve conflicts to head; leave everything else as-is.
	const index0 = await readIndex(gitCtx);
	const conflicted = new Set(index0.entries.filter((e) => e.stage > 0).map((e) => e.path));
	if (conflicted.size > 0) {
		const headMap = await flattenTreeToMap(gitCtx, headTree);
		const entries = getStage0Entries(index0);
		const worktreeOps = [];
		for (const path of conflicted) {
			const head = headMap.get(path);
			if (head) {
				const mode = parseInt(head.mode, 8);
				entries.push({ path, mode, hash: head.hash, stage: 0, stat: defaultStat() });
				worktreeOps.push({ path, type: "checkout" as const, hash: head.hash, mode });
			} else {
				worktreeOps.push({ path, type: "delete" as const });
			}
		}
		await writeIndex(gitCtx, { version: 2, entries });
		await applyWorktreeOps(gitCtx, worktreeOps);
	}

	// Step 2: two-way merge index tree → remote (preserves local changes; can fail).
	const index1 = await readIndex(gitCtx);
	const indexTree = await buildTreeFromIndex(gitCtx, getStage0Entries(index1));
	const ff = await unpackTrees(
		gitCtx,
		[
			{ label: "HEAD", treeHash: indexTree },
			{ label: "remote", treeHash: remoteTree },
		],
		index1,
		{ mergeFn: twowayMerge, updateWorktree: true, reset: false, stopAtFirstError: true },
	);
	if (!ff.success) return { ok: false, rejected: ff.errors[0] as RejectedPath };
	await writeIndex(gitCtx, { version: 2, entries: ff.newEntries });
	await applyWorktreeOps(gitCtx, ff.worktreeOps);

	// Step 3: one-way merge remote into the index (index := remote tree exactly).
	const index2 = await readIndex(gitCtx);
	const oneway = await unpackTrees(gitCtx, [{ label: "remote", treeHash: remoteTree }], index2, {
		mergeFn: onewayMerge,
		updateWorktree: false,
		reset: true,
	});
	await writeIndex(gitCtx, { version: 2, entries: oneway.newEntries });
	return { ok: true };
}

/**
 * git's `clean_index` unpack-trees failure: the plumbing (non-porcelain) error
 * message for the first rejected path, followed by `fatal: failed to clean
 * index`. Real git's `fast_forward_to` runs unpack-trees with `show_all_errors`
 * off, so only the first offending path is reported.
 */
function renderCleanIndexFailure(rejected: RejectedPath): string {
	const { path, error } = rejected;
	let msg: string;
	switch (error) {
		case UnpackError.WOULD_OVERWRITE:
			msg = `error: Entry '${path}' would be overwritten by merge. Cannot merge.\n`;
			break;
		case UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN:
			msg = `error: Untracked working tree file '${path}' would be overwritten by merge.\n`;
			break;
		case UnpackError.WOULD_LOSE_UNTRACKED_REMOVED:
			msg = `error: Untracked working tree file '${path}' would be removed by merge.\n`;
			break;
		default:
			msg = `error: Entry '${path}' not uptodate. Cannot merge.\n`;
			break;
	}
	return `${msg}fatal: failed to clean index\n`;
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
 * `--skip` (git's `am_skip`): `clean_index(HEAD, HEAD)` to discard the paused
 * patch's partial work (resolving conflicts back to HEAD while preserving
 * unrelated local changes), refresh the `am_next` bookkeeping (abort-safety +
 * counter), then resume the loop.
 */
async function handleSkip(gitCtx: GitContext, env: Map<string, string>): Promise<CommandResult> {
	const state = await readAmState(gitCtx);
	if (!state) return notResuming();

	const headHash = await resolveHead(gitCtx);
	const headTree = headHash
		? (await readCommit(gitCtx, headHash)).tree
		: await buildTreeFromIndex(gitCtx, []);
	const cleaned = await cleanIndex(gitCtx, headTree, headTree);
	if (!cleaned.ok) {
		return { stdout: "", stderr: renderCleanIndexFailure(cleaned.rejected), exitCode: 128 };
	}

	// git's `am_next`: refresh abort-safety to the current HEAD and advance the
	// counter. Then `am_run` unlinks any stale `dirtyindex` before re-entering
	// the apply loop.
	await refreshAbortSafety(gitCtx, await resolveHead(gitCtx));
	await setAmNext(gitCtx, state.next + 1);
	return runAmLoop(gitCtx, env);
}

/**
 * `--abort`: restore the pre-`am` HEAD (`orig-head`), reset the index +
 * worktree to it, and clear the state dir.
 *
 * git's `safe_to_abort` gate (in order):
 *   1. `dirtyindex` marker present → the session never applied anything onto a
 *      dirty index; just drop the state dir (no rewind, no warning).
 *   2. HEAD moved since `am` last acted (`HEAD != abort-safety`) → refuse to
 *      rewind, warn, and leave HEAD/branch where it is so hand-made work is not
 *      lost.
 *   3. otherwise → rewind to `orig-head`.
 */
async function handleAbort(gitCtx: GitContext, env: Map<string, string>): Promise<CommandResult> {
	const state = await readAmState(gitCtx);
	if (!state) return notResuming();

	// git's `safe_to_abort` bails on `dirtyindex` *before* the moved-HEAD check,
	// silently (the dirty index death never moved HEAD, so there is nothing to
	// rewind and no reason to warn).
	if (await hasDirtyIndex(gitCtx)) {
		await clearAmState(gitCtx);
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	// git's `safe_to_abort`: an empty `abort-safety` and an unborn HEAD both map
	// to the null oid, so `(HEAD ?? "") === abort-safety` is git's `oideq` check.
	const currentHead = await resolveHead(gitCtx);
	const safety = await readAbortSafety(gitCtx);
	if ((currentHead ?? "") !== safety) {
		await clearAmState(gitCtx);
		return {
			stdout: "",
			stderr:
				"warning: You seem to have moved HEAD since the last 'am' failure.\n" +
				"Not rewinding to ORIG_HEAD\n",
			exitCode: 0,
		};
	}

	// git's `am_abort`: `clean_index(curr_head, orig_head)` then move HEAD to
	// `orig_head`. `orig_head` comes from the `ORIG_HEAD` ref (git reads it live,
	// so an intervening rewrite redirects the abort target).
	const origHead = await resolveRef(gitCtx, "ORIG_HEAD");
	const currTree = currentHead
		? (await readCommit(gitCtx, currentHead)).tree
		: await buildTreeFromIndex(gitCtx, []);
	const origTree = origHead
		? (await readCommit(gitCtx, origHead)).tree
		: await buildTreeFromIndex(gitCtx, []);

	const cleaned = await cleanIndex(gitCtx, currTree, origTree);
	if (!cleaned.ok) {
		// git dies here without destroying the state dir — the session stays
		// resumable/abortable and HEAD is left where it was.
		return { stdout: "", stderr: renderCleanIndexFailure(cleaned.rejected), exitCode: 128 };
	}

	if (origHead) {
		await advanceBranchRef(gitCtx, origHead);
		// git's `am_abort` rewinds via `update_ref("am --abort", HEAD, orig_head,
		// curr_head, …)`. When HEAD is symbolic, git splits this into a normal
		// update of the branch plus a `REF_LOG_ONLY` deref update of HEAD:
		//   • the branch reflog entry is written only when the value actually
		//     changes (`REF_NEEDS_COMMIT`) — a session that committed no patch
		//     leaves `curr_head == orig_head`, so no branch entry is logged;
		//   • the HEAD reflog entry is `REF_LOG_ONLY`, so it is always written,
		//     even for a no-op rewind.
		// A detached HEAD is a plain direct update: logged only when it moves.
		const head = await readHead(gitCtx);
		const moved = currentHead !== origHead;
		if (head?.type === "symbolic") {
			if (moved) {
				await logRef(gitCtx, env, head.target, currentHead, origHead, "am --abort", false);
			}
			await logRef(gitCtx, env, "HEAD", currentHead, origHead, "am --abort", false);
		} else if (moved) {
			await logRef(gitCtx, env, "HEAD", currentHead, origHead, "am --abort", false);
		}
	} else {
		// No `ORIG_HEAD` (the `am` began on an unborn branch): git deletes the
		// current branch, returning to the unborn state.
		const head = await readHead(gitCtx);
		if (head?.type === "symbolic") await deleteRef(gitCtx, head.target);
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
