import { firstLine } from "./command-utils.ts";
import { walkCommits } from "./commit-walk.ts";
import { readCommit } from "./object-db.ts";
import { deleteStateFile, readStateFile, writeStateFile } from "./operation-state.ts";
import { join } from "./path.ts";
import { deleteRef, listRefs, resolveRef } from "./refs.ts";
import type { GitContext, GitRepo } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface BisectState {
	startRef: string;
	badHash: string | null;
	goodHashes: string[];
	skipHashes: string[];
	termBad: string;
	termGood: string;
	noCheckout: boolean;
	firstParent: boolean;
}

interface BisectResult {
	hash: string;
	subject: string;
	/** Number of revisions left to test after this one. */
	remaining: number;
	/** Estimated steps to narrow down. */
	steps: number;
	/** True when only one candidate remains — bisect is done. */
	found: boolean;
	/** True when all non-skipped candidates are exhausted (only skipped remain). */
	onlySkippedLeft: boolean;
}

// ── State queries ───────────────────────────────────────────────────

export async function isBisectInProgress(ctx: GitContext): Promise<boolean> {
	const content = await readStateFile(ctx, "BISECT_START");
	return content != null && content.trim().length > 0;
}

export async function readBisectTerms(
	ctx: GitContext,
): Promise<{ termBad: string; termGood: string }> {
	const raw = await readStateFile(ctx, "BISECT_TERMS");
	if (!raw) return { termBad: "bad", termGood: "good" };
	const lines = raw.trim().split("\n");
	return {
		termBad: lines[0] ?? "bad",
		termGood: lines[1] ?? "good",
	};
}

export async function readBisectState(ctx: GitContext): Promise<BisectState> {
	const startRef = (await readStateFile(ctx, "BISECT_START"))?.trim() ?? "";
	const { termBad, termGood } = await readBisectTerms(ctx);

	const badHash = await resolveRef(ctx, `refs/bisect/${termBad}`);

	const goodHashes: string[] = [];
	const skipHashes: string[] = [];

	const bisectRefs = await listRefs(ctx, "refs/bisect");
	for (const ref of bisectRefs) {
		if (ref.name.startsWith(`refs/bisect/${termGood}-`)) {
			goodHashes.push(ref.hash);
		} else if (ref.name.startsWith("refs/bisect/skip-")) {
			skipHashes.push(ref.hash);
		}
	}

	const noCheckout =
		(await readStateFile(ctx, "BISECT_HEAD")) != null ||
		(await ctx.fs.exists(join(ctx.gitDir, "BISECT_HEAD")));
	const firstParent = await ctx.fs.exists(join(ctx.gitDir, "BISECT_FIRST_PARENT"));

	return {
		startRef,
		badHash,
		goodHashes,
		skipHashes,
		termBad,
		termGood,
		noCheckout,
		firstParent,
	};
}

// ── State writes ────────────────────────────────────────────────────

export async function appendBisectLog(ctx: GitContext, line: string): Promise<void> {
	const existing = (await readStateFile(ctx, "BISECT_LOG")) ?? "";
	await writeStateFile(ctx, "BISECT_LOG", existing + line + "\n");
}

// ── State cleanup ───────────────────────────────────────────────────

export async function cleanBisectState(ctx: GitContext): Promise<void> {
	const bisectRefs = await listRefs(ctx, "refs/bisect");
	for (const ref of bisectRefs) {
		await deleteRef(ctx, ref.name);
	}

	await deleteStateFile(ctx, "BISECT_EXPECTED_REV");
	await deleteStateFile(ctx, "BISECT_ANCESTORS_OK");
	await deleteStateFile(ctx, "BISECT_LOG");
	await deleteStateFile(ctx, "BISECT_TERMS");
	await deleteStateFile(ctx, "BISECT_NAMES");
	await deleteStateFile(ctx, "BISECT_FIRST_PARENT");
	await deleteStateFile(ctx, "BISECT_HEAD");
	// BISECT_START removed last (signals end of bisect)
	await deleteStateFile(ctx, "BISECT_START");

	// Clean up the refs/bisect directory if it exists
	const bisectDir = join(ctx.gitDir, "refs", "bisect");
	if (await ctx.fs.exists(bisectDir)) {
		try {
			await ctx.fs.rm(bisectDir, { recursive: true });
		} catch {
			// ignore
		}
	}
}

// ── Binary search algorithm ─────────────────────────────────────────

/**
 * Find the best commit to test next during bisect.
 *
 * Enumerates all commits reachable from `badHash` but not from any
 * `goodHashes`, then picks the one whose "weight" (number of reachable
 * candidates) is closest to nr/2. This maximizes information gain per
 * test.
 */
export async function findBisectionCommit(
	ctx: GitRepo,
	badHash: string,
	goodHashes: string[],
	skipHashes: Set<string>,
	firstParent: boolean,
): Promise<BisectResult | null> {
	const candidates: Array<{ hash: string; subject: string }> = [];
	const parentMap = new Map<string, string[]>();

	for await (const entry of walkCommits(ctx, badHash, {
		exclude: goodHashes,
	})) {
		const parents = firstParent ? entry.commit.parents.slice(0, 1) : entry.commit.parents;
		candidates.push({
			hash: entry.hash,
			subject: firstLine(entry.commit.message),
		});
		parentMap.set(entry.hash, parents);
	}

	const nr = candidates.length;
	if (nr === 0) return null;

	if (nr === 1) {
		return {
			hash: candidates[0]!.hash,
			subject: candidates[0]!.subject,
			remaining: 0,
			steps: 0,
			found: true,
			onlySkippedLeft: false,
		};
	}

	const candidateSet = new Set(candidates.map((c) => c.hash));

	// Compute weight for each candidate: how many candidates are reachable
	// from it (including itself). This tells us how many commits would be
	// eliminated if this commit were marked "good".
	const weights = new Map<string, number>();

	for (const c of candidates) {
		const reachable = new Set<string>();
		const queue = [c.hash];
		let qi = 0;
		while (qi < queue.length) {
			const current = queue[qi++]!;
			if (reachable.has(current)) continue;
			if (!candidateSet.has(current)) continue;
			reachable.add(current);
			const parents = parentMap.get(current);
			if (parents) {
				for (const p of parents) {
					if (!reachable.has(p) && candidateSet.has(p)) {
						queue.push(p);
					}
				}
			}
		}
		weights.set(c.hash, reachable.size);
	}

	// Pick the candidate whose weight is closest to nr/2
	let bestHash = candidates[0]!.hash;
	let bestDistance = nr;

	for (const c of candidates) {
		if (skipHashes.has(c.hash)) continue;
		const w = weights.get(c.hash) ?? 0;
		const distance = Math.abs(2 * w - nr);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestHash = c.hash;
		}
	}

	// If all non-skipped candidates were exhausted, try skipped ones
	let onlySkippedLeft = false;
	if (bestDistance === nr) {
		onlySkippedLeft = true;
		for (const c of candidates) {
			const w = weights.get(c.hash) ?? 0;
			const distance = Math.abs(2 * w - nr);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestHash = c.hash;
			}
		}
	}

	const bestCandidate = candidates.find((c) => c.hash === bestHash)!;
	const remaining = computeRevisionsLeft(nr);
	const steps = computeSteps(nr);

	return {
		hash: bestCandidate.hash,
		subject: bestCandidate.subject,
		remaining,
		steps,
		found: false,
		onlySkippedLeft,
	};
}

/**
 * Compute the "revisions left to test" number displayed by git bisect.
 * Real git shows floor((nr - 1) / 2).
 */
function computeRevisionsLeft(nr: number): number {
	return Math.floor((nr - 1) / 2);
}

/**
 * Compute estimated steps remaining.
 * Real git uses ceil(log2(nr)).
 */
function computeSteps(nr: number): number {
	if (nr <= 1) return 0;
	return Math.ceil(Math.log2(nr));
}

// ── Status message formatting ───────────────────────────────────────

export function formatBisectStatus(state: BisectState): string {
	const hasBad = state.badHash != null;
	const goodCount = state.goodHashes.length;

	if (!hasBad && goodCount === 0) {
		return `status: waiting for both ${state.termGood} and ${state.termBad} commits\n`;
	}
	if (!hasBad) {
		return `status: waiting for ${state.termBad} commit, ${goodCount} ${state.termGood} commit(s) known\n`;
	}
	if (goodCount === 0) {
		return `status: waiting for ${state.termGood} commit(s), ${state.termBad} commit known\n`;
	}
	return "";
}

/**
 * Format the bisecting progress line:
 * "Bisecting: N revisions left to test after this (roughly M steps)"
 */
export function formatBisectingLine(result: BisectResult): string {
	return (
		`Bisecting: ${result.remaining} revision${result.remaining === 1 ? "" : "s"} left to test after this (roughly ${result.steps} step${result.steps === 1 ? "" : "s"})\n` +
		`[${result.hash}] ${result.subject}\n`
	);
}

/**
 * Format the "first bad commit found" message.
 */
export async function formatFirstBadCommit(ctx: GitRepo, hash: string): Promise<string> {
	const commit = await readCommit(ctx, hash);
	const subject = firstLine(commit.message);

	const authorDate = new Date(commit.author.timestamp * 1000);
	const dateStr = authorDate.toUTCString().replace("GMT", "+0000");

	let out = `${hash} is the first bad commit\n`;
	out += `commit ${hash}\n`;
	out += `Author: ${commit.author.name} <${commit.author.email}>\n`;
	out += `Date:   ${dateStr}\n`;
	out += `\n`;
	out += `    ${subject}\n`;
	out += `\n`;

	return out;
}
