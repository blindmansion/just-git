import type { CommandContext, GitExtensions } from "../git.ts";
import {
	clearAmState,
	isAmInProgress,
	patchFileName,
	readAmState,
	readPatchMessage,
	setAmNext,
	writeAmState,
	writeAmStopMeta,
} from "../lib/am.ts";
import { writeCommitAndAdvance } from "../lib/commit-write.ts";
import { getStage0Entries, readIndex } from "../lib/index.ts";
import { applyPatches } from "../lib/patch/apply.ts";
import { appendSignoff } from "../lib/patch/mbox.ts";
import { parseMail, splitMailbox } from "../lib/patch/mailinfo.ts";
import { ApplyParseError, parsePatch } from "../lib/patch/parse-patch.ts";
import { resolve } from "../lib/path.ts";
import { logRef } from "../lib/refs/reflog.ts";
import { readHead, resolveHead } from "../lib/refs/refs.ts";
import { buildTreeFromIndex } from "../lib/tree-ops.ts";
import type { GitContext, Identity } from "../lib/types.ts";
import { type CommandResult, err, fatal, isCommandError } from "./kit/command-result.ts";
import { resolveCommandSigner } from "./kit/command-utils.ts";
import {
	requireCommitter,
	requireGitContext,
	requireNoConflicts,
} from "./kit/commit-requirements.ts";
import { a, type Command, f } from "./kit/parse/index.ts";

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

/** The resolve-hint block git prints under a stopped `am`. */
const RESOLVE_HINT =
	"hint: Use 'git am --show-current-patch=diff' to see the failed patch\n" +
	'When you have resolved this problem, run "git am --continue".\n' +
	'If you prefer to skip this patch, run "git am --skip" instead.\n' +
	'To restore the original branch and stop patching, run "git am --abort".\n';

/** Assemble the commit message from a parsed mail + signoff option. */
function buildMessage(subject: string, body: string, signoffLine: string | null): string {
	const finalBody = signoffLine ? appendSignoff(subject, body, signoffLine) : body;
	return finalBody === "" ? `${subject}\n` : `${subject}\n\n${finalBody}\n`;
}

export function registerAmCommand(parent: Command, ext?: GitExtensions): void {
	parent.command("am", {
		description: "Apply a series of patches from a mailbox",
		args: [a.string().name("mbox").variadic().optional()],
		options: {
			"3way": f().alias("3").describe("Use a 3-way merge if the patch does not apply cleanly"),
			signoff: f().alias("s").describe("Add a Signed-off-by trailer to the commit message"),
			quiet: f().alias("q").describe("Suppress the 'Applying:' progress output"),
			keep: f().alias("k").describe("Pass the subject through verbatim (keep [PATCH])"),
			scissors: f().describe("Cut everything above a scissors line before the body"),
			keepCr: f().describe("Keep a trailing CR on body/patch lines"),
			committerDateIsAuthorDate: f().describe("Use the author date as the committer date"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// A session already running: start mode is refused (resume verbs land
			// in the next step).
			if (await isAmInProgress(gitCtx)) {
				return err(
					"error: previous rebase directory .git/rebase-apply still exists but mbox given.\n",
					128,
				);
			}

			// ── Gather input (file args, else stdin) ──────────────────
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

			// Refuse if the index has unmerged entries (mirror cherry-pick's guard).
			const index = await readIndex(gitCtx);
			const conflictErr = requireNoConflicts(index, "am");
			if (conflictErr) return conflictErr;

			// ── Split the mailbox, write the state dir ────────────────
			const messages = splitMailbox(text);
			if (messages.length === 0) {
				return err("Patch format detection failed.\n", 128);
			}

			const origHead = (await resolveHead(gitCtx)) ?? "";
			await writeAmState(
				gitCtx,
				{
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
				},
				messages,
			);

			return runAmLoop(gitCtx, ctx.env);
		},
	});
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

		if (!state.quiet) out.push(`Applying: ${mail.subject}\n`);

		// Parse the diff; an empty or unparseable patch is git's "Patch is empty".
		if (mail.patchText.trim() === "") {
			await clearAmState(gitCtx);
			return { stdout: out.join(""), stderr: "Patch is empty.\n", exitCode: 128 };
		}
		let patches;
		try {
			patches = parsePatch(mail.patchText);
		} catch (e) {
			if (e instanceof ApplyParseError) {
				await writeAmStopMeta(gitCtx, buildMessage(mail.subject, mail.body, null), mail.author);
				return {
					stdout: out.join(""),
					stderr: `error: corrupt patch at line ${e.line}\nPatch failed at ${patchFileName(
						state.next,
					)} ${mail.subject}\n${RESOLVE_HINT}`,
					exitCode: 128,
				};
			}
			throw e;
		}

		// ── Apply to the index + worktree ─────────────────────────
		const result = await applyPatches(gitCtx, patches, {
			reverse: false,
			target: "index",
			whitespace: "warn",
			unidiffZero: false,
			reject: false,
			threeway: state.threeway,
			check: false,
		});

		// Resolve the committer (per patch, so each gets the current time).
		const committer = await requireCommitter(gitCtx, env);
		if (isCommandError(committer)) return committer;
		const signoffLine = state.sign ? `Signed-off-by: ${committer.name} <${committer.email}>` : null;
		const message = buildMessage(mail.subject, mail.body, signoffLine);

		if (!result.ok) {
			// Stop, leaving the state dir for a later --continue / --abort.
			await writeAmStopMeta(gitCtx, message, mail.author);
			const errLines = result.errors.map((e) => `error: ${e}\n`).join("");
			return {
				stdout: out.join(""),
				stderr: `${errLines}Patch failed at ${patchFileName(state.next)} ${
					mail.subject
				}\n${RESOLVE_HINT}`,
				exitCode: 1,
			};
		}

		// ── Success: snapshot the index into a tree and commit ────
		const committerId: Identity = state.committerDateIsAuthorDate
			? { ...committer, timestamp: mail.author.timestamp, timezone: mail.author.timezone }
			: committer;

		const headHash = await resolveHead(gitCtx);
		const freshIndex = await readIndex(gitCtx);
		const tree = await buildTreeFromIndex(gitCtx, getStage0Entries(freshIndex));

		const signer = await resolveCommandSigner(gitCtx, undefined, "commit.gpgsign");
		if (isCommandError(signer)) return signer;

		const commitHash = await writeCommitAndAdvance(
			gitCtx,
			tree,
			headHash ? [headHash] : [],
			mail.author,
			committerId,
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
			`am: ${mail.subject}`,
			head?.type === "symbolic",
		);

		await setAmNext(gitCtx, state.next + 1);
	}

	return { stdout: out.join(""), stderr: "", exitCode: 0 };
}
