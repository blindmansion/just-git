import type { GitExtensions } from "../git.ts";
import { comparePaths, isCommandError, requireGitContext } from "../lib/command-utils.ts";
import { readConfig } from "../lib/config.ts";
import { readIndex } from "../lib/index.ts";
import { branchNameFromRef, readHead, resolveHead } from "../lib/refs.ts";
import {
	collapseUntrackedDirs,
	formatBranchTrackingInfo,
	generateLongFormStatus,
	getTrackingInfo,
	getStagedChanges,
	getUnmergedPaths,
	type StatusEntry,
	type TrackingInfo,
} from "../lib/status-format.ts";
import { diffIndexToWorkTree } from "../lib/worktree.ts";
import { type Command, f } from "../parse/index.ts";

export function registerStatusCommand(parent: Command, ext?: GitExtensions) {
	parent.command("status", {
		description: "Show the working tree status",
		options: {
			short: f().alias("s").describe("Give the output in the short-format"),
			porcelain: f().describe("Give the output in a machine-parseable format"),
			branch: f().alias("b").describe("Show the branch in short-format output"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			if (!args.short && !args.porcelain) {
				const stdout = await generateLongFormStatus(gitCtx);
				return { stdout, stderr: "", exitCode: 0 };
			}

			// Short / porcelain format — compute diffs up front
			const head = await readHead(gitCtx);
			const headHash = await resolveHead(gitCtx);
			let branchName: string;
			let branchHeader: string | null = null;
			if (head && head.type === "symbolic") {
				branchName = branchNameFromRef(head.target);
				if (args.branch) {
					const config = await readConfig(gitCtx);
					const tracking = await getTrackingInfo(gitCtx, config, branchName);
					branchHeader = formatShortBranchHeader(branchName, tracking);
				}
			} else {
				branchName = "HEAD detached";
				if (args.branch) {
					branchHeader = "## HEAD (no branch)";
				}
			}
			const index = await readIndex(gitCtx);
			const unmerged = getUnmergedPaths(index);
			const staged = await getStagedChanges(gitCtx, headHash, index, unmerged);
			const workTreeDiffs = await diffIndexToWorkTree(gitCtx, index);
			const unstaged: StatusEntry[] = [];
			const untracked: string[] = [];

			for (const diff of workTreeDiffs) {
				if (diff.status === "untracked") {
					untracked.push(diff.path);
				} else {
					unstaged.push({ path: diff.path, status: diff.status });
				}
			}
			unstaged.sort((a, b) => comparePaths(a.path, b.path));

			const trackedPaths = new Set(index.entries.map((e) => e.path));
			const collapsedUntracked = collapseUntrackedDirs(untracked, trackedPaths);

			const stdout = formatShortStatus(
				branchHeader,
				staged,
				unstaged,
				unmerged,
				collapsedUntracked,
			);
			return { stdout, stderr: "", exitCode: 0 };
		},
	});
}

// ── Short-format helpers ────────────────────────────────────────────

const UNMERGED_CODE: Record<string, string> = {
	"both modified": "UU",
	"both added": "AA",
	"both deleted": "DD",
	"deleted by us": "DU",
	"deleted by them": "UD",
	"added by us": "AU",
	"added by them": "UA",
	unmerged: "UU",
};

function stagedCode(status: string): string {
	switch (status) {
		case "new file":
			return "A";
		case "modified":
			return "M";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		default:
			return " ";
	}
}

function unstagedCode(status: string): string {
	switch (status) {
		case "modified":
			return "M";
		case "deleted":
			return "D";
		default:
			return " ";
	}
}

/**
 * Produce short-format output (used by -s/--short/--porcelain).
 * Format: "XY path" or "XY old -> new" for renames, one per line.
 */
function formatShortStatus(
	branchHeader: string | null,
	staged: StatusEntry[],
	unstaged: StatusEntry[],
	unmerged: StatusEntry[],
	collapsedUntracked: string[],
): string {
	const lines: string[] = [];

	if (branchHeader) {
		lines.push(branchHeader);
	}

	// Build lookup maps for merging XY codes
	const unmergedByPath = new Map(unmerged.map((e) => [e.path, e]));
	const stagedByPath = new Map(staged.map((e) => [e.path, e]));
	const unstagedByPath = new Map(unstaged.map((e) => [e.path, e]));

	// Collect all paths (deduped, sorted)
	const allPaths = new Set<string>();
	for (const e of unmerged) allPaths.add(e.path);
	for (const e of staged) allPaths.add(e.path);
	for (const e of unstaged) allPaths.add(e.path);

	const sortedPaths = [...allPaths].sort();

	for (const path of sortedPaths) {
		// Unmerged paths get their specific two-char code
		const unmergedEntry = unmergedByPath.get(path);
		if (unmergedEntry) {
			const code = UNMERGED_CODE[unmergedEntry.status] ?? "UU";
			lines.push(`${code} ${quotePath(path)}`);
			continue;
		}

		const s = stagedByPath.get(path);
		const u = unstagedByPath.get(path);

		const x = s ? stagedCode(s.status) : " ";
		const y = u ? unstagedCode(u.status) : " ";

		if (s?.status === "renamed" && s.displayPath) {
			const arrowIdx = s.displayPath.indexOf(" -> ");
			const oldP = s.displayPath.slice(0, arrowIdx);
			const newP = s.displayPath.slice(arrowIdx + 4);
			lines.push(`${x}${y} ${quotePath(oldP)} -> ${quotePath(newP)}`);
		} else {
			lines.push(`${x}${y} ${quotePath(path)}`);
		}
	}

	// Untracked files
	for (const path of collapsedUntracked) {
		lines.push(`?? ${quotePath(path)}`);
	}

	if (lines.length === 0) return "";
	return `${lines.join("\n")}\n`;
}

function formatShortBranchHeader(branchName: string, tracking: TrackingInfo | null): string {
	if (!tracking) return `## ${branchName}`;
	const base = `## ${branchName}...${tracking.upstream}`;
	const suffix = formatBranchTrackingInfo(tracking, false);
	return suffix ? `${base} ${suffix}` : base;
}

/**
 * Quote a path the way Git does for porcelain/short output.
 */
function quotePath(path: string): string {
	if (!/[ \t"\\]/.test(path) && !/[^\x20-\x7E]/.test(path)) return path;
	const escaped = path
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\t/g, "\\t")
		.replace(/\n/g, "\\n");
	return `"${escaped}"`;
}
