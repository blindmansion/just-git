import type { GitExtensions } from "../git.ts";
import {
	type CommandResult,
	err,
	fatal,
	isCommandError,
	requireGitContext,
} from "../lib/command-utils.ts";
import { formatUnifiedDiff } from "../lib/diff-algorithm.ts";
import { getConflictedPaths, readIndex } from "../lib/index.ts";
import { readBlobContent, readCommit } from "../lib/object-db.ts";
import { resolveHead } from "../lib/refs.ts";
import {
	applyStash,
	clearStashes,
	dropStash,
	listStashEntries,
	readStashRef,
	saveStash,
} from "../lib/stash.ts";
import { generateLongFormStatus } from "../lib/status-format.ts";
import { diffTrees } from "../lib/tree-ops.ts";
import type { GitContext, ObjectId, TreeDiffEntry } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function parseStashArg(arg: string | undefined): number {
	if (arg === undefined) return 0;

	const match = arg.match(/^(?:stash@\{)?(\d+)\}?$/);
	if (match?.[1] !== undefined) return parseInt(match[1], 10);

	const num = parseInt(arg, 10);
	if (!Number.isNaN(num) && num >= 0) return num;

	return -1;
}

async function formatTreeDiff(ctx: GitContext, diff: TreeDiffEntry): Promise<string> {
	const oldContent = diff.oldHash ? await readBlobContent(ctx, diff.oldHash) : "";
	const newContent = diff.newHash ? await readBlobContent(ctx, diff.newHash) : "";

	return formatUnifiedDiff({
		path: diff.path,
		oldContent,
		newContent,
		oldMode: diff.oldMode,
		newMode: diff.newMode,
	});
}

// ── Hook helpers ────────────────────────────────────────────────────

type StashAction = "push" | "pop" | "apply" | "list" | "drop" | "show" | "clear";

async function emitPreStash(
	ext: GitExtensions | undefined,
	action: StashAction,
	ref: string | null,
) {
	if (!ext?.hooks) return null;
	return ext.hooks.emitPre("pre-stash", { action, ref });
}

async function emitPostStash(ext: GitExtensions | undefined, action: StashAction, ok: boolean) {
	await ext?.hooks?.emitPost("post-stash", { action, ok });
}

// ── Command registration ────────────────────────────────────────────

export function registerStashCommand(parent: Command, ext?: GitExtensions) {
	const stash = parent.command("stash", {
		description: "Stash the changes in a dirty working directory away",
		options: {
			message: o.string().alias("m").describe("Stash message"),
			"include-untracked": f().alias("u").describe("Also stash untracked files"),
		},
		transformArgs: (tokens) => {
			if (tokens[0] !== "save") return tokens;
			const rest = tokens.slice(1);
			const flags: string[] = [];
			const positionals: string[] = [];
			for (const t of rest) {
				if (t.startsWith("-")) flags.push(t);
				else positionals.push(t);
			}
			if (positionals.length > 0) {
				return [...flags, "-m", positionals.join(" ")];
			}
			return flags;
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const abort = await emitPreStash(ext, "push", null);
			if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
			const result = await handlePush(
				gitCtxOrError,
				ctx.env,
				args.message,
				args["include-untracked"],
			);
			await emitPostStash(ext, "push", result.exitCode === 0);
			return result;
		},
	});

	stash.command("push", {
		description: "Save your local modifications to a new stash entry",
		options: {
			message: o.string().alias("m").describe("Stash message"),
			"include-untracked": f().alias("u").describe("Also stash untracked files"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const abort = await emitPreStash(ext, "push", null);
			if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
			const result = await handlePush(
				gitCtxOrError,
				ctx.env,
				args.message,
				args["include-untracked"],
			);
			await emitPostStash(ext, "push", result.exitCode === 0);
			return result;
		},
	});

	stash.command("pop", {
		description: "Remove a single stash entry and apply it on top of the current working tree",
		args: [a.string().name("stash").describe("Stash reference (e.g. stash@{0})").optional()],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const abort = await emitPreStash(ext, "pop", args.stash ?? null);
			if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
			const result = await handlePop(gitCtxOrError, args.stash);
			await emitPostStash(ext, "pop", result.exitCode === 0);
			return result;
		},
	});

	stash.command("apply", {
		description: "Apply a stash entry on top of the current working tree",
		args: [a.string().name("stash").describe("Stash reference (e.g. stash@{0})").optional()],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const abort = await emitPreStash(ext, "apply", args.stash ?? null);
			if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
			const result = await handleApply(gitCtxOrError, args.stash);
			await emitPostStash(ext, "apply", result.exitCode === 0);
			return result;
		},
	});

	stash.command("list", {
		description: "List the stash entries that you currently have",
		handler: async (_args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const abort = await emitPreStash(ext, "list", null);
			if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
			const result = await handleList(gitCtxOrError);
			await emitPostStash(ext, "list", result.exitCode === 0);
			return result;
		},
	});

	stash.command("drop", {
		description: "Remove a single stash entry from the list of stash entries",
		args: [a.string().name("stash").describe("Stash reference (e.g. stash@{0})").optional()],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const abort = await emitPreStash(ext, "drop", args.stash ?? null);
			if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
			const result = await handleDrop(gitCtxOrError, args.stash);
			await emitPostStash(ext, "drop", result.exitCode === 0);
			return result;
		},
	});

	stash.command("show", {
		description: "Show the changes recorded in a stash entry as a diff",
		args: [a.string().name("stash").describe("Stash reference (e.g. stash@{0})").optional()],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const abort = await emitPreStash(ext, "show", args.stash ?? null);
			if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
			const result = await handleShow(gitCtxOrError, args.stash);
			await emitPostStash(ext, "show", result.exitCode === 0);
			return result;
		},
	});

	stash.command("clear", {
		description: "Remove all the stash entries",
		handler: async (_args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const abort = await emitPreStash(ext, "clear", null);
			if (abort) return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
			const result = await handleClear(gitCtxOrError);
			await emitPostStash(ext, "clear", result.exitCode === 0);
			return result;
		},
	});
}

// ── Subcommand handlers ─────────────────────────────────────────────

async function handlePush(
	gitCtx: GitContext,
	env: Map<string, string>,
	message: string | undefined,
	includeUntracked?: boolean,
): Promise<CommandResult> {
	const headHash = await resolveHead(gitCtx);
	if (!headHash) {
		return err("You do not have the initial commit yet\n");
	}

	const idx = await readIndex(gitCtx);
	const unmergedPaths = getConflictedPaths(idx).sort();
	if (unmergedPaths.length > 0) {
		return {
			stdout: `${unmergedPaths.map((p) => `${p}: needs merge`).join("\n")}\n`,
			stderr: "error: could not write index\n",
			exitCode: 1,
		};
	}

	let stashHash: ObjectId | null;
	try {
		stashHash = await saveStash(gitCtx, env, message, { includeUntracked });
	} catch (e) {
		return fatal((e as Error).message);
	}

	if (!stashHash) {
		return {
			stdout: "No local changes to save\n",
			stderr: "",
			exitCode: 0,
		};
	}

	const stashCommit = await readCommit(gitCtx, stashHash);
	const msg = stashCommit.message.trim();

	return {
		stdout: `Saved working directory and index state ${msg}\n`,
		stderr: "",
		exitCode: 0,
	};
}

async function handlePop(gitCtx: GitContext, refArg: string | undefined): Promise<CommandResult> {
	const stashIndex = parseStashArg(refArg);
	if (stashIndex < 0) {
		return err(`error: '${refArg}' is not a valid stash reference`);
	}

	const hash = await readStashRef(gitCtx, stashIndex);
	if (!hash) {
		return err(`error: stash@{${stashIndex}} is not a valid reference`);
	}

	const result = await applyStash(gitCtx, stashIndex);
	if (!result.ok) {
		const mergeOutput = result.messages?.length ? `${result.messages.join("\n")}\n` : "";
		if (result.stdout) {
			return {
				stdout: `${mergeOutput}${result.stdout}The stash entry is kept in case you need it again.\n`,
				stderr: result.stderr,
				exitCode: result.exitCode,
			};
		}
		const statusOutput = await generateLongFormStatus(gitCtx);
		return {
			stdout: `${mergeOutput}${statusOutput}The stash entry is kept in case you need it again.\n`,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}

	if (result.hasConflicts) {
		const mergeOutput = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";
		const statusOutput = await generateLongFormStatus(gitCtx);
		return {
			stdout: `${mergeOutput}${statusOutput}The stash entry is kept in case you need it again.\n`,
			stderr: "",
			exitCode: 1,
		};
	}

	const dropErr = await dropStash(gitCtx, stashIndex);
	if (dropErr) {
		return err(dropErr);
	}

	const mergeOutput = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";
	const refLabel = refArg ? `stash@{${stashIndex}}` : `refs/stash@{${stashIndex}}`;
	const statusOutput = await generateLongFormStatus(gitCtx);
	return {
		stdout: `${mergeOutput}${statusOutput}Dropped ${refLabel} (${hash})\n`,
		stderr: "",
		exitCode: 0,
	};
}

async function handleApply(gitCtx: GitContext, refArg: string | undefined): Promise<CommandResult> {
	const stashIndex = parseStashArg(refArg);
	if (stashIndex < 0) {
		return err(`error: '${refArg}' is not a valid stash reference`);
	}

	const result = await applyStash(gitCtx, stashIndex);
	if (!result.ok) {
		const mergeOutput = result.messages?.length ? `${result.messages.join("\n")}\n` : "";
		let stdout = result.stdout;
		if (!stdout) {
			stdout = await generateLongFormStatus(gitCtx);
		}
		return {
			stdout: `${mergeOutput}${stdout}`,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}

	const mergeOutput = result.messages.length > 0 ? `${result.messages.join("\n")}\n` : "";
	const statusOutput = await generateLongFormStatus(gitCtx);
	const exitCode = result.hasConflicts ? 1 : 0;
	return { stdout: `${mergeOutput}${statusOutput}`, stderr: "", exitCode };
}

async function handleList(gitCtx: GitContext): Promise<CommandResult> {
	const entries = await listStashEntries(gitCtx);
	if (entries.length === 0) {
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	const lines = entries.map((e) => `stash@{${e.index}}: ${e.message}`);
	return {
		stdout: `${lines.join("\n")}\n`,
		stderr: "",
		exitCode: 0,
	};
}

async function handleDrop(gitCtx: GitContext, refArg: string | undefined): Promise<CommandResult> {
	const stashIndex = parseStashArg(refArg);
	if (stashIndex < 0) {
		return err(`error: '${refArg}' is not a valid stash reference`);
	}

	const hash = await readStashRef(gitCtx, stashIndex);
	if (!hash) {
		return err(`error: stash@{${stashIndex}} is not a valid reference`);
	}

	const dropErr = await dropStash(gitCtx, stashIndex);
	if (dropErr) {
		return err(dropErr);
	}

	const refLabel = refArg ? `stash@{${stashIndex}}` : `refs/stash@{${stashIndex}}`;
	return {
		stdout: `Dropped ${refLabel} (${hash})\n`,
		stderr: "",
		exitCode: 0,
	};
}

async function handleShow(gitCtx: GitContext, refArg: string | undefined): Promise<CommandResult> {
	const stashIndex = parseStashArg(refArg);
	if (stashIndex < 0) {
		return err(`error: '${refArg}' is not a valid stash reference`);
	}

	const stashHash = await readStashRef(gitCtx, stashIndex);
	if (!stashHash) {
		return err(`error: stash@{${stashIndex}} is not a valid reference`);
	}

	const stashCommit = await readCommit(gitCtx, stashHash);
	const parentHash = stashCommit.parents[0];
	if (!parentHash) {
		return err("error: invalid stash commit (no parent)");
	}

	const parent = await readCommit(gitCtx, parentHash);
	const diffs = await diffTrees(gitCtx, parent.tree, stashCommit.tree);

	let output = "";
	for (const diff of diffs) {
		output += await formatTreeDiff(gitCtx, diff);
	}

	return { stdout: output, stderr: "", exitCode: 0 };
}

async function handleClear(gitCtx: GitContext): Promise<CommandResult> {
	await clearStashes(gitCtx);
	return { stdout: "", stderr: "", exitCode: 0 };
}
