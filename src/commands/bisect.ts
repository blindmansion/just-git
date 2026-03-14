import type { GitExtensions } from "../git.ts";
import {
	type CommandResult,
	abbreviateHash,
	fatal,
	firstLine,
	isCommandError,
	requireGitContext,
	requireRevision,
	requireWorkTree,
} from "../lib/command-utils.ts";
import {
	appendBisectLog,
	type BisectState,
	cleanBisectState,
	findBisectionCommit,
	formatBisectStatus,
	formatBisectingLine,
	formatFirstBadCommit,
	isBisectInProgress,
	readBisectState,
	readBisectTerms,
} from "../lib/bisect.ts";
import { detachHeadCore, switchBranchCore } from "../lib/checkout-utils.ts";
import { readCommit } from "../lib/object-db.ts";
import { readStateFile, writeStateFile } from "../lib/operation-state.ts";
import { join } from "../lib/path.ts";
import { readHead, resolveHead, resolveRef, updateRef } from "../lib/refs.ts";
import { resolveRevision } from "../lib/rev-parse.ts";
import type { GitContext } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

// ── Reserved subcommand names (cannot be used as custom terms) ──────

const RESERVED_TERMS = new Set([
	"help",
	"start",
	"skip",
	"next",
	"reset",
	"visualize",
	"view",
	"replay",
	"log",
	"run",
	"terms",
]);

const NOT_BISECTING: CommandResult = {
	stdout: 'You need to start by "git bisect start"\n',
	stderr: "",
	exitCode: 1,
};

async function resolveBisectHead(gitCtx: GitContext): Promise<string | CommandResult> {
	const bh = await readStateFile(gitCtx, "BISECT_HEAD");
	if (bh?.trim()) return bh.trim();
	const h = await resolveHead(gitCtx);
	if (!h) return fatal("no current commit");
	return h;
}

// ── Registration ────────────────────────────────────────────────────

export function registerBisectCommand(parent: Command, ext?: GitExtensions) {
	const bisect = parent.command("bisect", {
		description: "Use binary search to find the commit that introduced a bug",
		args: [
			a.string().name("subcommand").describe("Subcommand or custom term").optional(),
			a.string().name("rest").describe("Additional arguments").optional().variadic(),
		],
		handler: async (args, ctx) => {
			const subcommand: string | undefined = args.subcommand;
			if (!subcommand) {
				return {
					stdout: "",
					stderr:
						"usage: git bisect [start|bad|good|new|old|terms|skip|next|reset|visualize|view|replay|log|run]\n",
					exitCode: 1,
				};
			}

			const restArgs: string[] = args.rest ?? [];

			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			return handleTermAlias(gitCtx, ctx.env, ext, subcommand, restArgs);
		},
	});

	registerStart(bisect, ext);
	registerBadGoodNewOld(bisect, ext);
	registerSkip(bisect, ext);
	registerReset(bisect, ext);
	registerLog(bisect, ext);
	registerReplay(bisect, ext);
	registerRun(bisect, ext);
	registerTerms(bisect, ext);
	registerVisualize(bisect, ext);
}

// ── Subcommand: start ───────────────────────────────────────────────

function registerStart(parent: Command, ext?: GitExtensions) {
	parent.command("start", {
		description: "Start bisecting",
		args: [a.string().name("revs").describe("Bad and good revisions").optional().variadic()],
		options: {
			"term-new": o.string().describe("Alternate term for new/bad"),
			"term-bad": o.string().describe("Alternate term for new/bad"),
			"term-old": o.string().describe("Alternate term for old/good"),
			"term-good": o.string().describe("Alternate term for old/good"),
			"no-checkout": f().describe("Do not checkout the bisection commit"),
			"first-parent": f().describe("Follow only first parent on merges"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const workTreeErr = requireWorkTree(gitCtx);
			if (workTreeErr && !args["no-checkout"]) return workTreeErr;

			const termBad = args["term-new"] ?? args["term-bad"] ?? "bad";
			const termGood = args["term-old"] ?? args["term-good"] ?? "good";

			if (RESERVED_TERMS.has(termBad)) {
				return fatal(`'${termBad}' is not a valid term`);
			}
			if (RESERVED_TERMS.has(termGood)) {
				return fatal(`'${termGood}' is not a valid term`);
			}
			if (termBad === termGood) {
				return fatal("'bad' and 'good' terms must be different");
			}

			return handleStart(
				gitCtx,
				ctx.env,
				ext,
				args.revs ?? [],
				termBad,
				termGood,
				args["no-checkout"] ?? false,
				args["first-parent"] ?? false,
			);
		},
	});
}

async function handleStart(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	revArgs: string[],
	termBad: string,
	termGood: string,
	noCheckout: boolean,
	firstParent: boolean,
): Promise<CommandResult> {
	if (await isBisectInProgress(gitCtx)) {
		await cleanBisectState(gitCtx);
	}

	const head = await readHead(gitCtx);
	let startRef: string;
	if (head?.type === "symbolic") {
		startRef = head.target.replace(/^refs\/heads\//, "");
	} else {
		const headHash = await resolveHead(gitCtx);
		startRef = headHash ?? "HEAD";
	}

	await writeStateFile(gitCtx, "BISECT_START", startRef + "\n");
	await writeStateFile(gitCtx, "BISECT_TERMS", `${termBad}\n${termGood}\n`);
	await writeStateFile(gitCtx, "BISECT_NAMES", "\n");

	if (firstParent) {
		await writeStateFile(gitCtx, "BISECT_FIRST_PARENT", "");
	}
	if (noCheckout) {
		const headHash = await resolveHead(gitCtx);
		if (headHash) {
			await writeStateFile(gitCtx, "BISECT_HEAD", headHash);
		}
	}

	if (revArgs.length > 0) {
		const badRev = revArgs[0]!;
		const badHash = await requireRevision(gitCtx, badRev);
		if (isCommandError(badHash)) return badHash;
		await updateRef(gitCtx, `refs/bisect/${termBad}`, badHash);

		const commit = await readCommit(gitCtx, badHash);
		await appendBisectLog(gitCtx, `# ${termBad}: [${badHash}] ${firstLine(commit.message)}`);

		for (let i = 1; i < revArgs.length; i++) {
			const goodRev = revArgs[i]!;
			const goodHash = await requireRevision(gitCtx, goodRev);
			if (isCommandError(goodHash)) return goodHash;
			await updateRef(gitCtx, `refs/bisect/${termGood}-${goodHash}`, goodHash);

			const gc = await readCommit(gitCtx, goodHash);
			await appendBisectLog(gitCtx, `# ${termGood}: [${goodHash}] ${firstLine(gc.message)}`);
		}
	}

	const quotedArgs = revArgs.map((r) => `'${r}'`);
	const startLogArgs = quotedArgs.length > 0 ? ` ${quotedArgs.join(" ")}` : "";
	await appendBisectLog(gitCtx, `git bisect start${startLogArgs}`);

	return checkAndAdvanceBisect(gitCtx, env, ext);
}

// ── Subcommand: bad/good/new/old ────────────────────────────────────

function registerBadGoodNewOld(parent: Command, ext?: GitExtensions) {
	for (const name of ["bad", "good", "new", "old"] as const) {
		parent.command(name, {
			description:
				name === "bad" || name === "new" ? "Mark a commit as bad/new" : "Mark a commit as good/old",
			args: [a.string().name("rev").describe("Revision to mark").optional()],
			handler: async (args, ctx) => {
				const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
				if (isCommandError(gitCtxOrError)) return gitCtxOrError;

				return handleMark(gitCtxOrError, ctx.env, ext, name, args.rev);
			},
		});
	}
}

async function handleMark(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	builtinTerm: "bad" | "good" | "new" | "old",
	revArg: string | undefined,
): Promise<CommandResult> {
	if (!(await isBisectInProgress(gitCtx))) return NOT_BISECTING;

	const terms = await readBisectTerms(gitCtx);
	const actualTerm =
		builtinTerm === "bad" || builtinTerm === "new" ? terms.termBad : terms.termGood;
	return markRevision(gitCtx, env, ext, actualTerm, terms, revArg);
}

async function handleTermAlias(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	term: string,
	restArgs: string[],
): Promise<CommandResult> {
	if (!(await isBisectInProgress(gitCtx))) return NOT_BISECTING;

	const terms = await readBisectTerms(gitCtx);
	if (term !== terms.termBad && term !== terms.termGood) {
		return {
			stdout: "",
			stderr: `error: unknown command: 'git bisect ${term}'\n`,
			exitCode: 1,
		};
	}

	return markRevision(gitCtx, env, ext, term, terms, restArgs[0]);
}

async function markRevision(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	term: string,
	terms: { termBad: string; termGood: string },
	revArg: string | undefined,
): Promise<CommandResult> {
	let hash: string;
	if (revArg) {
		const resolved = await requireRevision(gitCtx, revArg);
		if (isCommandError(resolved)) return resolved;
		hash = resolved;
	} else {
		const headResult = await resolveBisectHead(gitCtx);
		if (isCommandError(headResult)) return headResult;
		hash = headResult;
	}

	const commit = await readCommit(gitCtx, hash);
	const subject = firstLine(commit.message);

	if (term === terms.termBad) {
		await updateRef(gitCtx, `refs/bisect/${terms.termBad}`, hash);
	} else {
		await updateRef(gitCtx, `refs/bisect/${terms.termGood}-${hash}`, hash);
	}

	await appendBisectLog(gitCtx, `# ${term}: [${hash}] ${subject}`);
	await appendBisectLog(gitCtx, `git bisect ${term} ${hash}`);

	return checkAndAdvanceBisect(gitCtx, env, ext);
}

// ── Subcommand: skip ────────────────────────────────────────────────

function registerSkip(parent: Command, ext?: GitExtensions) {
	parent.command("skip", {
		description: "Mark a commit as untestable",
		args: [a.string().name("revs").describe("Revisions to skip").optional().variadic()],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			if (!(await isBisectInProgress(gitCtx))) return NOT_BISECTING;

			const revs: string[] = args.revs ?? [];
			if (revs.length === 0) {
				const headResult = await resolveBisectHead(gitCtx);
				if (isCommandError(headResult)) return headResult;
				revs.push(headResult);
			}

			for (const rev of revs) {
				let hash: string;
				if (rev.length === 40 && /^[0-9a-f]+$/.test(rev)) {
					hash = rev;
				} else {
					const resolved = await requireRevision(gitCtx, rev);
					if (isCommandError(resolved)) return resolved;
					hash = resolved;
				}

				await updateRef(gitCtx, `refs/bisect/skip-${hash}`, hash);
				const commit = await readCommit(gitCtx, hash);
				await appendBisectLog(gitCtx, `# skip: [${hash}] ${firstLine(commit.message)}`);
				await appendBisectLog(gitCtx, `git bisect skip ${hash}`);
			}

			return checkAndAdvanceBisect(gitCtx, ctx.env, ext);
		},
	});
}

// ── Subcommand: reset ───────────────────────────────────────────────

function registerReset(parent: Command, ext?: GitExtensions) {
	parent.command("reset", {
		description: "Finish bisecting and return to original branch",
		args: [a.string().name("commit").describe("Branch or commit to checkout").optional()],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			if (!(await isBisectInProgress(gitCtx))) {
				return { stdout: "We are not bisecting.\n", stderr: "", exitCode: 0 };
			}

			return handleReset(gitCtx, ctx.env, ext, args.commit);
		},
	});
}

async function handleReset(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	targetArg: string | undefined,
): Promise<CommandResult> {
	const startRef = (await readStateFile(gitCtx, "BISECT_START"))?.trim() ?? "";
	await cleanBisectState(gitCtx);

	if (targetArg) {
		const resolved = await requireRevision(gitCtx, targetArg);
		if (isCommandError(resolved)) return resolved;
		return detachHeadCore(gitCtx, resolved, env, ext);
	}

	if (startRef) {
		const refName = `refs/heads/${startRef}`;
		const branchHash = await resolveRef(gitCtx, refName);
		if (branchHash) {
			return switchBranchCore(gitCtx, startRef, refName, branchHash, env, ext);
		}
		const resolved = await resolveRevision(gitCtx, startRef);
		if (resolved) {
			return detachHeadCore(gitCtx, resolved, env, ext);
		}
	}

	return { stdout: "", stderr: "", exitCode: 0 };
}

// ── Subcommand: log ─────────────────────────────────────────────────

function registerLog(parent: Command, ext?: GitExtensions) {
	parent.command("log", {
		description: "Show the bisect log",
		handler: async (_args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			if (!(await isBisectInProgress(gitCtx))) {
				return {
					stdout: "",
					stderr: "error: We are not bisecting.\n",
					exitCode: 1,
				};
			}

			const log = (await readStateFile(gitCtx, "BISECT_LOG")) ?? "";
			return { stdout: log, stderr: "", exitCode: 0 };
		},
	});
}

// ── Subcommand: replay ──────────────────────────────────────────────

function registerReplay(parent: Command, ext?: GitExtensions) {
	parent.command("replay", {
		description: "Replay a bisect log",
		args: [a.string().name("logfile").describe("Path to bisect log file")],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const logPath = args.logfile.startsWith("/") ? args.logfile : join(ctx.cwd, args.logfile);
			if (!(await ctx.fs.exists(logPath))) {
				return fatal(`cannot open '${args.logfile}': No such file or directory`);
			}

			const content = await ctx.fs.readFile(logPath);
			return handleReplay(gitCtx, ctx.env, ext, content);
		},
	});
}

async function handleReplay(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	logContent: string,
): Promise<CommandResult> {
	if (await isBisectInProgress(gitCtx)) {
		await cleanBisectState(gitCtx);
	}

	const defaultTerms = { termBad: "bad", termGood: "good" };
	let stdout = "";

	for (const line of logContent.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const match = trimmed.match(/^git[\s-]bisect\s+(\S+)(.*)$/);
		if (!match) continue;

		const cmd = match[1]!;
		const rest = match[2]!.trim();

		let result: CommandResult;
		if (cmd === "start") {
			const args = rest ? rest.split(/\s+/).map((a) => a.replace(/^'|'$/g, "")) : [];
			result = await handleStart(gitCtx, env, ext, args, "bad", "good", false, false);
		} else if (cmd === "bad" || cmd === "new") {
			result = await markRevision(gitCtx, env, ext, "bad", defaultTerms, rest || undefined);
		} else if (cmd === "good" || cmd === "old") {
			result = await markRevision(gitCtx, env, ext, "good", defaultTerms, rest || undefined);
		} else if (cmd === "skip") {
			for (const rev of rest ? rest.split(/\s+/) : []) {
				await updateRef(gitCtx, `refs/bisect/skip-${rev}`, rev);
				const commit = await readCommit(gitCtx, rev);
				await appendBisectLog(gitCtx, `# skip: [${rev}] ${firstLine(commit.message)}`);
				await appendBisectLog(gitCtx, `git bisect skip ${rev}`);
			}
			result = await checkAndAdvanceBisect(gitCtx, env, ext);
		} else {
			continue;
		}

		if (result.exitCode !== 0) return result;
		stdout += result.stdout;
	}

	return { stdout, stderr: "", exitCode: 0 };
}

// ── Subcommand: run ─────────────────────────────────────────────────

function registerRun(parent: Command, ext?: GitExtensions) {
	parent.command("run", {
		description: "Bisect by running a command",
		args: [a.string().name("cmd").describe("Command and arguments to run").variadic()],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			if (!(await isBisectInProgress(gitCtx))) return NOT_BISECTING;
			if (!ctx.exec) return fatal("bisect run requires shell execution support");

			const cmdStr = (args.cmd as string[]).join(" ");
			return handleRun(gitCtx, ctx.env, ext, cmdStr, ctx.exec, ctx.cwd);
		},
	});
}

async function handleRun(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	command: string,
	exec: (
		cmd: string,
		opts: { cwd: string },
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
	cwd: string,
): Promise<CommandResult> {
	let stdout = "";

	for (;;) {
		stdout += `running '${command}'\n`;

		const result = await exec(command, { cwd });
		const exitCode = result.exitCode;

		if (exitCode === 125) {
			const headResult = await resolveBisectHead(gitCtx);
			if (isCommandError(headResult)) return headResult;
			await updateRef(gitCtx, `refs/bisect/skip-${headResult}`, headResult);
			const commit = await readCommit(gitCtx, headResult);
			await appendBisectLog(gitCtx, `# skip: [${headResult}] ${firstLine(commit.message)}`);
			await appendBisectLog(gitCtx, `git bisect skip ${headResult}`);

			const advResult = await checkAndAdvanceBisect(gitCtx, env, ext);
			stdout += advResult.stdout;
			if (advResult.stdout.includes("is the first bad commit")) {
				stdout += "bisect found first bad commit\n";
				return { stdout, stderr: "", exitCode: 0 };
			}
			if (advResult.exitCode !== 0) {
				return { stdout, stderr: advResult.stderr, exitCode: advResult.exitCode };
			}
			continue;
		}

		const state = await readBisectState(gitCtx);
		const term = exitCode === 0 ? state.termGood : state.termBad;
		const markResult = await markRevision(gitCtx, env, ext, term, state, undefined);
		stdout += markResult.stdout;

		if (markResult.stdout.includes("is the first bad commit")) {
			stdout += "bisect found first bad commit\n";
			return { stdout, stderr: "", exitCode: 0 };
		}

		if (markResult.exitCode !== 0) {
			return { stdout, stderr: markResult.stderr, exitCode: markResult.exitCode };
		}
	}
}

// ── Subcommand: terms ───────────────────────────────────────────────

function registerTerms(parent: Command, ext?: GitExtensions) {
	parent.command("terms", {
		description: "Show the terms used for old and new commits",
		options: {
			"term-good": f().describe("Show the term for the old state"),
			"term-bad": f().describe("Show the term for the new state"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			if (!(await isBisectInProgress(gitCtx))) {
				return {
					stdout: "",
					stderr: "error: no terms defined\n",
					exitCode: 1,
				};
			}

			const { termBad, termGood } = await readBisectTerms(gitCtx);

			if (args["term-good"]) {
				return { stdout: `${termGood}\n`, stderr: "", exitCode: 0 };
			}
			if (args["term-bad"]) {
				return { stdout: `${termBad}\n`, stderr: "", exitCode: 0 };
			}

			return {
				stdout: `Your current terms are ${termGood} for the old state\nand ${termBad} for the new state.\n`,
				stderr: "",
				exitCode: 0,
			};
		},
	});
}

// ── Subcommand: visualize/view ──────────────────────────────────────

function registerVisualize(parent: Command, ext?: GitExtensions) {
	for (const name of ["visualize", "view"] as const) {
		parent.command(name, {
			description: "Show remaining suspects in git log",
			handler: async (_args, ctx) => {
				const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
				if (isCommandError(gitCtxOrError)) return gitCtxOrError;
				const gitCtx = gitCtxOrError;

				if (!(await isBisectInProgress(gitCtx))) return NOT_BISECTING;

				const state = await readBisectState(gitCtx);
				if (!state.badHash || state.goodHashes.length === 0) {
					return {
						stdout: "",
						stderr: "error: need both bad and good commits to visualize\n",
						exitCode: 1,
					};
				}

				const { walkCommits } = await import("../lib/commit-walk.ts");
				let stdout = "";
				for await (const entry of walkCommits(gitCtx, state.badHash, {
					exclude: state.goodHashes,
				})) {
					stdout += `${abbreviateHash(entry.hash)} ${firstLine(entry.commit.message)}\n`;
				}

				return { stdout, stderr: "", exitCode: 0 };
			},
		});
	}
}

// ── Core: auto-next ─────────────────────────────────────────────────

async function checkAndAdvanceBisect(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
): Promise<CommandResult> {
	const state = await readBisectState(gitCtx);
	if (!state.badHash || state.goodHashes.length === 0) {
		return { stdout: formatBisectStatus(state), stderr: "", exitCode: 0 };
	}
	await writeStateFile(gitCtx, "BISECT_ANCESTORS_OK", "");
	return bisectAutoNext(gitCtx, env, ext, state);
}

async function bisectAutoNext(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	state: BisectState,
): Promise<CommandResult> {
	const result = await findBisectionCommit(
		gitCtx,
		state.badHash!,
		state.goodHashes,
		new Set(state.skipHashes),
		state.firstParent,
	);

	if (!result) {
		return {
			stdout: "",
			stderr: "error: no testable commits found\n",
			exitCode: 1,
		};
	}

	if (result.found) {
		const foundOutput = await formatFirstBadCommit(gitCtx, result.hash);
		await appendBisectLog(gitCtx, `# first bad commit: [${result.hash}] ${result.subject}`);
		return { stdout: foundOutput, stderr: "", exitCode: 0 };
	}

	if (result.onlySkippedLeft) {
		let out =
			"There are only 'skip'ped commits left to test.\nThe first bad commit could be any of:\n";
		for (const sh of state.skipHashes) {
			out += sh + "\n";
		}
		if (state.badHash) {
			out += state.badHash + "\n";
		}
		out += "We cannot bisect more!\n";
		return { stdout: out, stderr: "", exitCode: 2 };
	}

	if (state.noCheckout) {
		await writeStateFile(gitCtx, "BISECT_HEAD", result.hash);
	} else {
		const checkoutResult = await detachHeadCore(gitCtx, result.hash, env, ext);
		if (checkoutResult.exitCode !== 0) return checkoutResult;
	}

	await writeStateFile(gitCtx, "BISECT_EXPECTED_REV", result.hash + "\n");
	return { stdout: formatBisectingLine(result), stderr: "", exitCode: 0 };
}
