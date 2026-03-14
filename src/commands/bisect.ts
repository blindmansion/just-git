import type { GitExtensions } from "../git.ts";
import {
	type CommandResult,
	abbreviateHash,
	fatal,
	firstLine,
	isCommandError,
	requireGitContext,
	requireWorkTree,
} from "../lib/command-utils.ts";
import {
	appendBisectLog,
	cleanBisectState,
	findBisectionCommit,
	formatBisectStatus,
	formatBisectingLine,
	formatFirstBadCommit,
	isBisectInProgress,
	readBisectState,
	readBisectTerms,
	writeBisectAncestorsOk,
	writeBisectBad,
	writeBisectExpectedRev,
	writeBisectGood,
	writeBisectNames,
	writeBisectSkip,
	writeBisectStart,
	writeBisectTerms,
} from "../lib/bisect.ts";
import { detachHeadCore, switchBranchCore } from "../lib/checkout-utils.ts";
import { readCommit } from "../lib/object-db.ts";
import { readStateFile, writeStateFile } from "../lib/operation-state.ts";
import { join } from "../lib/path.ts";
import { readHead, resolveHead, resolveRef } from "../lib/refs.ts";
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
	// If already bisecting, clean up first
	if (await isBisectInProgress(gitCtx)) {
		await cleanBisectState(gitCtx);
	}

	// Record where we started from
	const head = await readHead(gitCtx);
	let startRef: string;
	if (head?.type === "symbolic") {
		startRef = head.target.replace(/^refs\/heads\//, "");
	} else {
		const headHash = await resolveHead(gitCtx);
		startRef = headHash ?? "HEAD";
	}

	await writeBisectStart(gitCtx, startRef);
	await writeBisectTerms(gitCtx, termBad, termGood);
	await writeBisectNames(gitCtx, "");

	if (firstParent) {
		await writeStateFile(gitCtx, "BISECT_FIRST_PARENT", "");
	}
	if (noCheckout) {
		const headHash = await resolveHead(gitCtx);
		if (headHash) {
			await writeStateFile(gitCtx, "BISECT_HEAD", headHash);
		}
	}

	// Build log entry with quoted args
	const quotedArgs = revArgs.map((r) => `'${r}'`);
	const startLogArgs = quotedArgs.length > 0 ? ` ${quotedArgs.join(" ")}` : "";

	let stdout = "";
	let badHash: string | null = null;
	const goodHashes: string[] = [];

	// Parse rev args: first is bad, rest are good
	if (revArgs.length > 0) {
		const badRev = revArgs[0]!;
		const resolved = await resolveRevision(gitCtx, badRev);
		if (!resolved) return fatal(`bad revision '${badRev}'`);
		badHash = resolved;
		await writeBisectBad(gitCtx, badHash, termBad);

		const commit = await readCommit(gitCtx, badHash);
		const subject = firstLine(commit.message);
		await appendBisectLog(gitCtx, `# ${termBad}: [${badHash}] ${subject}`);

		for (let i = 1; i < revArgs.length; i++) {
			const goodRev = revArgs[i]!;
			const goodHash = await resolveRevision(gitCtx, goodRev);
			if (!goodHash) return fatal(`bad revision '${goodRev}'`);
			goodHashes.push(goodHash);
			await writeBisectGood(gitCtx, goodHash, termGood);

			const gc = await readCommit(gitCtx, goodHash);
			const gs = firstLine(gc.message);
			await appendBisectLog(gitCtx, `# ${termGood}: [${goodHash}] ${gs}`);
		}
	}

	await appendBisectLog(gitCtx, `git bisect start${startLogArgs}`);

	// Auto-next: if we have both bad and good, find midpoint
	if (badHash && goodHashes.length > 0) {
		await writeBisectAncestorsOk(gitCtx);
		const result = await bisectAutoNext(
			gitCtx,
			env,
			ext,
			badHash,
			goodHashes,
			new Set(),
			noCheckout,
			firstParent,
		);
		return result;
	}

	// Not enough info yet — show status
	const state = await readBisectState(gitCtx);
	stdout = formatBisectStatus(state);
	return { stdout, stderr: "", exitCode: 0 };
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
	if (!(await isBisectInProgress(gitCtx))) {
		return {
			stdout: 'You need to start by "git bisect start"\n',
			stderr: "",
			exitCode: 1,
		};
	}

	const { termBad, termGood } = await readBisectTerms(gitCtx);

	// Map built-in command names to the active terms
	let actualTerm: string;
	if (builtinTerm === "bad" || builtinTerm === "new") {
		actualTerm = termBad;
	} else {
		actualTerm = termGood;
	}

	return markRevision(gitCtx, env, ext, actualTerm, revArg);
}

async function handleTermAlias(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	term: string,
	restArgs: string[],
): Promise<CommandResult> {
	if (!(await isBisectInProgress(gitCtx))) {
		return {
			stdout: 'You need to start by "git bisect start"\n',
			stderr: "",
			exitCode: 1,
		};
	}

	const { termBad, termGood } = await readBisectTerms(gitCtx);

	if (term !== termBad && term !== termGood) {
		return {
			stdout: "",
			stderr: `error: unknown command: 'git bisect ${term}'\n`,
			exitCode: 1,
		};
	}

	return markRevision(gitCtx, env, ext, term, restArgs[0]);
}

async function markRevision(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	term: string,
	revArg: string | undefined,
): Promise<CommandResult> {
	const { termBad, termGood } = await readBisectTerms(gitCtx);
	const state = await readBisectState(gitCtx);
	const isBad = term === termBad;

	// Resolve revision
	let hash: string;
	if (revArg) {
		const resolved = await resolveRevision(gitCtx, revArg);
		if (!resolved) return fatal(`bad revision '${revArg}'`);
		hash = resolved;
	} else if (state.noCheckout) {
		const bisectHead = await readStateFile(gitCtx, "BISECT_HEAD");
		hash = bisectHead?.trim() ?? "";
		if (!hash) {
			const h = await resolveHead(gitCtx);
			if (!h) return fatal("no current commit");
			hash = h;
		}
	} else {
		const h = await resolveHead(gitCtx);
		if (!h) return fatal("no current commit");
		hash = h;
	}

	const commit = await readCommit(gitCtx, hash);
	const subject = firstLine(commit.message);

	// Write ref and log
	if (isBad) {
		await writeBisectBad(gitCtx, hash, termBad);
	} else {
		await writeBisectGood(gitCtx, hash, termGood);
	}

	await appendBisectLog(gitCtx, `# ${term}: [${hash}] ${subject}`);
	await appendBisectLog(gitCtx, `git bisect ${term} ${hash}`);

	// Re-read state after writing
	const newState = await readBisectState(gitCtx);

	// Check if we have enough info for auto-next
	if (!newState.badHash || newState.goodHashes.length === 0) {
		const status = formatBisectStatus(newState);
		return { stdout: status, stderr: "", exitCode: 0 };
	}

	await writeBisectAncestorsOk(gitCtx);
	return bisectAutoNext(
		gitCtx,
		env,
		ext,
		newState.badHash,
		newState.goodHashes,
		new Set(newState.skipHashes),
		newState.noCheckout,
		newState.firstParent,
	);
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

			if (!(await isBisectInProgress(gitCtx))) {
				return {
					stdout: 'You need to start by "git bisect start"\n',
					stderr: "",
					exitCode: 1,
				};
			}

			const revs: string[] = args.revs ?? [];
			const state = await readBisectState(gitCtx);

			if (revs.length === 0) {
				// Skip current HEAD
				let hash: string;
				if (state.noCheckout) {
					const bh = await readStateFile(gitCtx, "BISECT_HEAD");
					hash = bh?.trim() ?? "";
					if (!hash) {
						const h = await resolveHead(gitCtx);
						if (!h) return fatal("no current commit");
						hash = h;
					}
				} else {
					const h = await resolveHead(gitCtx);
					if (!h) return fatal("no current commit");
					hash = h;
				}
				revs.push(hash);
			}

			for (const rev of revs) {
				let hash: string;
				if (rev.length === 40 && /^[0-9a-f]+$/.test(rev)) {
					hash = rev;
				} else {
					const resolved = await resolveRevision(gitCtx, rev);
					if (!resolved) return fatal(`bad revision '${rev}'`);
					hash = resolved;
				}

				await writeBisectSkip(gitCtx, hash);

				const commit = await readCommit(gitCtx, hash);
				const subject = firstLine(commit.message);
				await appendBisectLog(gitCtx, `# skip: [${hash}] ${subject}`);
				await appendBisectLog(gitCtx, `git bisect skip ${hash}`);
			}

			const newState = await readBisectState(gitCtx);
			if (!newState.badHash || newState.goodHashes.length === 0) {
				const status = formatBisectStatus(newState);
				return { stdout: status, stderr: "", exitCode: 0 };
			}

			return bisectAutoNext(
				gitCtx,
				ctx.env,
				ext,
				newState.badHash,
				newState.goodHashes,
				new Set(newState.skipHashes),
				newState.noCheckout,
				newState.firstParent,
			);
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

	let stderr = "";

	if (targetArg) {
		const resolved = await resolveRevision(gitCtx, targetArg);
		if (!resolved) return fatal(`bad revision '${targetArg}'`);
		const result = await detachHeadCore(gitCtx, resolved, env, ext);
		return result;
	}

	// Try to switch back to the branch we started from
	if (startRef) {
		const refName = `refs/heads/${startRef}`;
		const branchHash = await resolveRef(gitCtx, refName);
		if (branchHash) {
			const result = await switchBranchCore(gitCtx, startRef, refName, branchHash, env, ext);
			return result;
		}
		// startRef might be a hash (was detached when bisect started)
		const resolved = await resolveRevision(gitCtx, startRef);
		if (resolved) {
			const result = await detachHeadCore(gitCtx, resolved, env, ext);
			return result;
		}
	}

	return { stdout: "", stderr, exitCode: 0 };
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
	// Clean up any existing bisect state
	if (await isBisectInProgress(gitCtx)) {
		await cleanBisectState(gitCtx);
	}

	let stdout = "";
	const lines = logContent.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Parse "git bisect <cmd> [args...]" or "git-bisect <cmd> [args...]"
		const match = trimmed.match(/^git[\s-]bisect\s+(\S+)(.*)$/);
		if (!match) continue;

		const cmd = match[1]!;
		const rest = match[2]!.trim();

		if (cmd === "start") {
			const args = rest ? rest.split(/\s+/).map((a) => a.replace(/^'|'$/g, "")) : [];
			const result = await handleStart(gitCtx, env, ext, args, "bad", "good", false, false);
			if (result.exitCode !== 0) return result;
			stdout += result.stdout;
		} else if (cmd === "bad" || cmd === "new") {
			const result = await markRevision(gitCtx, env, ext, "bad", rest || undefined);
			if (result.exitCode !== 0) return result;
			stdout += result.stdout;
		} else if (cmd === "good" || cmd === "old") {
			const result = await markRevision(gitCtx, env, ext, "good", rest || undefined);
			if (result.exitCode !== 0) return result;
			stdout += result.stdout;
		} else if (cmd === "skip") {
			const revs = rest ? rest.split(/\s+/) : [];
			for (const rev of revs) {
				await writeBisectSkip(gitCtx, rev);
				const commit = await readCommit(gitCtx, rev);
				const subject = firstLine(commit.message);
				await appendBisectLog(gitCtx, `# skip: [${rev}] ${subject}`);
				await appendBisectLog(gitCtx, `git bisect skip ${rev}`);
			}
			const state = await readBisectState(gitCtx);
			if (state.badHash && state.goodHashes.length > 0) {
				const result = await bisectAutoNext(
					gitCtx,
					env,
					ext,
					state.badHash,
					state.goodHashes,
					new Set(state.skipHashes),
					state.noCheckout,
					state.firstParent,
				);
				if (result.exitCode !== 0) return result;
				stdout += result.stdout;
			}
		}
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

			if (!(await isBisectInProgress(gitCtx))) {
				return {
					stdout: 'You need to start by "git bisect start"\n',
					stderr: "",
					exitCode: 1,
				};
			}

			if (!ctx.exec) {
				return fatal("bisect run requires shell execution support");
			}

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

		const state = await readBisectState(gitCtx);
		const { termBad, termGood } = state;

		let term: string;
		if (exitCode === 0) {
			term = termGood;
		} else if (exitCode === 125) {
			// skip
			const headHash = await resolveHead(gitCtx);
			if (headHash) {
				await writeBisectSkip(gitCtx, headHash);
				const commit = await readCommit(gitCtx, headHash);
				const subject = firstLine(commit.message);
				await appendBisectLog(gitCtx, `# skip: [${headHash}] ${subject}`);
				await appendBisectLog(gitCtx, `git bisect skip ${headHash}`);
			}

			const newState = await readBisectState(gitCtx);
			if (!newState.badHash || newState.goodHashes.length === 0) {
				return { stdout, stderr: "", exitCode: 0 };
			}
			const nextResult = await bisectAutoNext(
				gitCtx,
				env,
				ext,
				newState.badHash,
				newState.goodHashes,
				new Set(newState.skipHashes),
				newState.noCheckout,
				newState.firstParent,
			);
			stdout += nextResult.stdout;
			if (nextResult.stdout.includes("is the first bad commit")) {
				stdout += "bisect found first bad commit\n";
				return { stdout, stderr: "", exitCode: 0 };
			}
			continue;
		} else if (exitCode >= 1 && exitCode <= 127 && exitCode !== 125) {
			term = termBad;
		} else {
			term = termBad;
		}

		const markResult = await markRevision(gitCtx, env, ext, term, undefined);
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

				if (!(await isBisectInProgress(gitCtx))) {
					return {
						stdout: 'You need to start by "git bisect start"\n',
						stderr: "",
						exitCode: 1,
					};
				}

				const state = await readBisectState(gitCtx);
				if (!state.badHash || state.goodHashes.length === 0) {
					return {
						stdout: "",
						stderr: "error: need both bad and good commits to visualize\n",
						exitCode: 1,
					};
				}

				// List all commits in the bisect range
				const { walkCommits } = await import("../lib/commit-walk.ts");
				let stdout = "";
				for await (const entry of walkCommits(gitCtx, state.badHash, {
					exclude: state.goodHashes,
				})) {
					const short = abbreviateHash(entry.hash);
					const subject = firstLine(entry.commit.message);
					stdout += `${short} ${subject}\n`;
				}

				return { stdout, stderr: "", exitCode: 0 };
			},
		});
	}
}

// ── Core: auto-next ─────────────────────────────────────────────────

async function bisectAutoNext(
	gitCtx: GitContext,
	env: Map<string, string>,
	ext: GitExtensions | undefined,
	badHash: string,
	goodHashes: string[],
	skipHashes: Set<string>,
	noCheckout: boolean,
	firstParent: boolean,
): Promise<CommandResult> {
	const result = await findBisectionCommit(gitCtx, badHash, goodHashes, skipHashes, firstParent);

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

	// Checkout or update BISECT_HEAD
	if (noCheckout) {
		await writeStateFile(gitCtx, "BISECT_HEAD", result.hash);
	} else {
		const checkoutResult = await detachHeadCore(gitCtx, result.hash, env, ext);
		if (checkoutResult.exitCode !== 0) {
			return checkoutResult;
		}
	}

	await writeBisectExpectedRev(gitCtx, result.hash);

	const stdout = formatBisectingLine(result);
	return { stdout, stderr: "", exitCode: 0 };
}
