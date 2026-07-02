/**
 * Core branch-switching / detach-HEAD orchestration shared by the `checkout`,
 * `switch`, and `bisect` commands. This is command-layer glue, not a lib data
 * primitive: it drives lib mutations + gatherers and assembles the final
 * `CommandResult` output via the `commands/kit/format/checkout` renderers.
 */
import type { GitExtensions } from "../../git.ts";
import { uniqueAbbrev } from "../../lib/abbrev.ts";
import type { CommandResult } from "./command-result.ts";
import { readConfig } from "../../lib/config/store.ts";
import { ZERO_HASH } from "../../lib/hex.ts";
import { readIndex, writeIndex } from "../../lib/index.ts";
import { readCommit } from "../../lib/object-db.ts";
import { clearDetachPoint, writeDetachPoint } from "../../lib/operation-state.ts";
import { logRef } from "../../lib/refs/reflog.ts";
import { createSymbolicRef, readHead, resolveHead, updateRef } from "../../lib/refs/refs.ts";
import { formatLongTrackingInfo } from "./format/status.ts";
import { getTrackingInfo } from "../../lib/status-format.ts";
import { firstLine } from "../../lib/text-utils.ts";
import type { GitContext, ObjectId } from "../../lib/types.ts";
import {
	clearOperationState,
	computeCheckoutStatus,
	gatherDetachPreamble,
} from "../../lib/worktree/checkout-utils.ts";
import {
	applyWorktreeOps,
	checkoutTrees,
	type RejectedPath,
} from "../../lib/worktree/unpack-trees.ts";
import {
	renderCancelWarnings,
	renderCheckoutSummary,
	renderDetachPreamble,
} from "./format/checkout.ts";
import { renderUnpackErrors } from "./format/unpack-trees.ts";

/**
 * Map a blocked `checkoutTrees` result (worktree-safety rejections) to the
 * `CommandResult` git prints. Shared by `checkout`, `switch`, and the
 * detach/switch core so the "checkout"/"switch branches" wording stays in one
 * place.
 */
export function renderCheckoutUnpackFailure(rejected: RejectedPath[]): CommandResult {
	return {
		stdout: "",
		stderr: renderUnpackErrors(rejected, {
			operationName: "checkout",
			actionHint: "switch branches",
		}),
		exitCode: 1,
	};
}

/**
 * Build the "<path>: needs merge" file list that real git prints to
 * stdout when checkout is blocked by unmerged index entries.
 */
function formatUnmergedList(index: { entries: { path: string; stage: number }[] }): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const e of index.entries) {
		if (e.stage > 0 && !seen.has(e.path)) {
			seen.add(e.path);
			lines.push(`${e.path}: needs merge`);
		}
	}
	lines.sort();
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Return an error result if the index has unmerged entries, or null if clean.
 * Combines hasConflicts check + formatUnmergedList output, matching the
 * standard "you need to resolve your current index first" message.
 */
export function requireResolvedIndex(index: {
	entries: { path: string; stage: number }[];
}): CommandResult | null {
	if (!index.entries.some((e) => e.stage > 0)) return null;
	return {
		stdout: formatUnmergedList(index),
		stderr: "error: you need to resolve your current index first\n",
		exitCode: 1,
	};
}

/**
 * Core branch-switching logic shared by `checkout` and `switch`.
 * Handles: already-on check, conflict check, tree checkout, detach
 * preamble, HEAD/reflog update, post-checkout hook, and tracking info.
 * Callers perform their own pre-checks (hooks, active-operation guards).
 */
export async function switchBranchCore(
	gitCtx: GitContext,
	branchName: string,
	refName: string,
	targetHash: ObjectId,
	env: Map<string, string>,
	ext?: GitExtensions,
	opts?: { isNew?: boolean },
): Promise<CommandResult> {
	const head = await readHead(gitCtx);
	if (head?.type === "symbolic" && head.target === refName) {
		return {
			stdout: "",
			stderr: `Already on '${branchName}'\n`,
			exitCode: 0,
		};
	}

	let currentIndex = await readIndex(gitCtx);
	const conflictErr = requireResolvedIndex(currentIndex);
	if (conflictErr) return conflictErr;

	const currentHash = await resolveHead(gitCtx);
	const targetCommit = await readCommit(gitCtx, targetHash);
	const targetTree = targetCommit.tree;

	let currentTree: ObjectId | null = null;
	if (currentHash) {
		const currentCommit = await readCommit(gitCtx, currentHash);
		currentTree = currentCommit.tree;
	}

	if (currentTree !== targetTree) {
		const result = await checkoutTrees(gitCtx, currentTree, targetTree, currentIndex);
		if (!result.success) {
			return renderCheckoutUnpackFailure(result.errors);
		}
		currentIndex = { version: 2, entries: result.newEntries };
		await writeIndex(gitCtx, currentIndex);
		await applyWorktreeOps(gitCtx, result.worktreeOps);
	}

	let detachPreamble = "";
	if (head?.type === "direct" && currentHash) {
		detachPreamble = renderDetachPreamble(
			await gatherDetachPreamble(gitCtx, currentHash, targetHash),
		);
	}

	const fromName =
		head?.type === "symbolic"
			? head.target.replace(/^refs\/heads\//, "")
			: (currentHash ?? ZERO_HASH);
	await createSymbolicRef(gitCtx, "HEAD", refName);
	await clearDetachPoint(gitCtx);
	const opWarning = renderCancelWarnings(await clearOperationState(gitCtx));

	await logRef(
		gitCtx,
		env,
		"HEAD",
		currentHash,
		targetHash,
		`checkout: moving from ${fromName} to ${branchName}`,
	);

	await ext?.capabilities?.hooks?.postCheckout?.({
		repo: gitCtx,
		prevHead: currentHash,
		newHead: targetHash,
		isBranchCheckout: true,
	});

	let stdout = renderCheckoutSummary(await computeCheckoutStatus(gitCtx, targetTree, currentIndex));

	const config = await readConfig(gitCtx);
	const trackingInfo = await getTrackingInfo(gitCtx, config, branchName);
	if (trackingInfo) {
		stdout += formatLongTrackingInfo(trackingInfo);
	}

	return {
		stdout,
		stderr: `${detachPreamble}Switched to ${opts?.isNew ? "a new " : ""}branch '${branchName}'\n${opWarning}`,
		exitCode: 0,
	};
}

/**
 * Core detach-HEAD logic shared by `checkout` and `switch`.
 * Handles: conflict check, tree checkout, ref update, reflog,
 * post-checkout hook, and checkout summary.
 *
 * When `detachAdviceTarget` is set and HEAD was previously on a branch,
 * the full detached-HEAD advice is shown (checkout behavior). Otherwise
 * only "HEAD is now at ..." is shown (switch behavior).
 */
export async function detachHeadCore(
	gitCtx: GitContext,
	targetHash: ObjectId,
	env: Map<string, string>,
	ext?: GitExtensions,
	opts?: {
		detachAdviceTarget?: string;
	},
): Promise<CommandResult> {
	let currentIndex = await readIndex(gitCtx);
	const conflictErr = requireResolvedIndex(currentIndex);
	if (conflictErr) return conflictErr;

	const currentHash = await resolveHead(gitCtx);
	const targetCommit = await readCommit(gitCtx, targetHash);
	const targetTree = targetCommit.tree;

	let currentTree: ObjectId | null = null;
	if (currentHash) {
		const currentCommit = await readCommit(gitCtx, currentHash);
		currentTree = currentCommit.tree;
	}

	if (currentTree !== targetTree) {
		const result = await checkoutTrees(gitCtx, currentTree, targetTree, currentIndex);
		if (!result.success) {
			return renderCheckoutUnpackFailure(result.errors);
		}
		currentIndex = { version: 2, entries: result.newEntries };
		await writeIndex(gitCtx, currentIndex);
		await applyWorktreeOps(gitCtx, result.worktreeOps);
	}

	const head = await readHead(gitCtx);
	const wasAlreadyDetachedAtTarget = head?.type === "direct" && currentHash === targetHash;

	await updateRef(gitCtx, "HEAD", targetHash);
	if (!wasAlreadyDetachedAtTarget) {
		await writeDetachPoint(gitCtx, targetHash);
		const fromName =
			head?.type === "symbolic"
				? head.target.replace(/^refs\/heads\//, "")
				: (currentHash ?? ZERO_HASH);
		await logRef(
			gitCtx,
			env,
			"HEAD",
			currentHash,
			targetHash,
			`checkout: moving from ${fromName} to ${targetHash}`,
		);
	}
	const opWarning = renderCancelWarnings(await clearOperationState(gitCtx));

	await ext?.capabilities?.hooks?.postCheckout?.({
		repo: gitCtx,
		prevHead: currentHash,
		newHead: targetHash,
		isBranchCheckout: false,
	});

	const shortHash = await uniqueAbbrev(gitCtx, targetHash);
	const subject = firstLine(targetCommit.message);
	const alreadyDetached = head?.type === "direct";

	let stderr = "";

	if (alreadyDetached && currentHash && currentHash !== targetHash) {
		stderr += renderDetachPreamble(await gatherDetachPreamble(gitCtx, currentHash, targetHash));
	}

	if (alreadyDetached || !opts?.detachAdviceTarget) {
		stderr += `HEAD is now at ${shortHash} ${subject}\n`;
	} else {
		stderr =
			`Note: switching to '${opts.detachAdviceTarget}'.\n` +
			`\n` +
			`You are in 'detached HEAD' state. You can look around, make experimental\n` +
			`changes and commit them, and you can discard any commits you make in this\n` +
			`state without impacting any branches by switching back to a branch.\n` +
			`\n` +
			`If you want to create a new branch to retain commits you create, you may\n` +
			`do so (now or later) by using -c with the switch command. Example:\n` +
			`\n` +
			`  git switch -c <new-branch-name>\n` +
			`\n` +
			`Or undo this operation with:\n` +
			`\n` +
			`  git switch -\n` +
			`\n` +
			`Turn off this advice by setting config variable advice.detachedHead to false\n` +
			`\n` +
			`HEAD is now at ${shortHash} ${subject}\n`;
	}

	stderr += opWarning;

	const stdout = renderCheckoutSummary(
		await computeCheckoutStatus(gitCtx, targetTree, currentIndex),
	);

	return { stdout, stderr, exitCode: 0 };
}
