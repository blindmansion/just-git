/**
 * Shared value-selection helpers for random walk actions.
 *
 * Each picker selects a value from the current repo state. When
 * `fuzzRate` is set, there's a chance of returning a plausible-but-wrong
 * value to exercise error handling paths.
 */

import type { QueryState, WalkHarness } from "./harness";
import type { SeededRNG } from "./rng";

// ── Types ────────────────────────────────────────────────────────────

interface PickerOpts {
	fuzzRate?: number;
}

// ── State helpers ────────────────────────────────────────────────────

/** Whether any conflict state (merge, cherry-pick, revert, or rebase) is active. */
export function inConflict(state: QueryState): boolean {
	return (
		state.inMergeConflict ||
		state.inCherryPickConflict ||
		state.inRevertConflict ||
		state.inRebaseConflict
	);
}

// ── Name generators ──────────────────────────────────────────────────

const BRANCH_PREFIXES = ["feature", "fix", "topic", "dev", "wip"];

/** Generate a branch name that doesn't collide with existing ones. */
export function newBranchName(rng: SeededRNG, existing: string[]): string {
	for (let attempt = 0; attempt < 20; attempt++) {
		const name = `${rng.pick(BRANCH_PREFIXES)}-${rng.alphanumeric(4)}`;
		if (!existing.includes(name)) return name;
	}
	return `branch-${rng.alphanumeric(8)}`;
}

const TAG_PREFIXES = ["v", "release-", "beta-", "rc-"];

/** Generate a random tag name. */
export function newTagName(rng: SeededRNG): string {
	return `${rng.pick(TAG_PREFIXES)}${rng.int(1, 99)}.${rng.int(0, 9)}`;
}

// ── Fuzz value generators ────────────────────────────────────────────

function fuzzBranchName(rng: SeededRNG): string {
	return `nonexistent-${rng.alphanumeric(6)}`;
}

function fuzzFilePath(rng: SeededRNG): string {
	const dirs = ["", "src/", "lib/", "fake/", "missing/"];
	return `${rng.pick(dirs)}no-such-file-${rng.alphanumeric(5)}.txt`;
}

function fuzzCommitHash(rng: SeededRNG): string {
	return rng.alphanumeric(rng.pick([7, 12, 40]));
}

function fuzzTagName(rng: SeededRNG): string {
	return `no-tag-${rng.alphanumeric(5)}`;
}

function fuzzRemoteName(rng: SeededRNG): string {
	return `no-remote-${rng.alphanumeric(4)}`;
}

function shouldFuzz(rng: SeededRNG, opts?: PickerOpts): boolean {
	const rate = opts?.fuzzRate ?? 0;
	return rate > 0 && rng.next() < rate;
}

// ── Pickers ──────────────────────────────────────────────────────────

/**
 * Pick a branch that isn't the current one.
 * Returns null if there are no other branches (and fuzzing didn't fire).
 */
export function pickOtherBranch(
	rng: SeededRNG,
	state: QueryState,
	opts?: PickerOpts,
): string | null {
	if (shouldFuzz(rng, opts)) return fuzzBranchName(rng);
	const others = state.branches.filter((b) => b !== state.currentBranch);
	return others.length > 0 ? rng.pick(others) : null;
}

/** Pick any branch (including current). */
export function pickAnyBranch(rng: SeededRNG, state: QueryState, opts?: PickerOpts): string | null {
	if (shouldFuzz(rng, opts)) return fuzzBranchName(rng);
	return state.branches.length > 0 ? rng.pick(state.branches) : null;
}

/** Pick a random worktree file path. */
export function pickFile(rng: SeededRNG, state: QueryState, opts?: PickerOpts): string | null {
	if (shouldFuzz(rng, opts)) return fuzzFilePath(rng);
	return state.files.length > 0 ? rng.pick(state.files) : null;
}

/**
 * Pick a recent commit hash from a branch (or current HEAD).
 * Runs `git log` to discover hashes. Returns null if no commits found.
 */
export async function pickCommitHash(
	harness: WalkHarness,
	rng: SeededRNG,
	opts?: PickerOpts & { branch?: string; n?: number },
): Promise<string | null> {
	if (shouldFuzz(rng, opts)) return fuzzCommitHash(rng);
	const branch = opts?.branch;
	const n = opts?.n ?? 5;
	const cmd = branch ? `log ${branch} --format=%H -n ${n}` : `log --format=%H -n ${n}`;
	const logResult = await harness.git(cmd);
	const hashes = logResult.stdout.trim().split("\n").filter(Boolean);
	return hashes.length > 0 ? rng.pick(hashes) : null;
}

/**
 * Pick a recent merge commit hash from a branch (or current HEAD).
 * Uses parent count from `git log --format="%H %P"`.
 */
export async function pickMergeCommitHash(
	harness: WalkHarness,
	rng: SeededRNG,
	opts?: PickerOpts & { branch?: string; n?: number },
): Promise<string | null> {
	if (shouldFuzz(rng, opts)) return fuzzCommitHash(rng);
	const branch = opts?.branch;
	const n = opts?.n ?? 20;
	const cmd = branch ? `log ${branch} --format="%H %P" -n ${n}` : `log --format="%H %P" -n ${n}`;
	const logResult = await harness.git(cmd);
	const hashes = logResult.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((parts) => parts.length >= 3)
		.map((parts) => parts[0]!)
		.filter(Boolean);
	return hashes.length > 0 ? rng.pick(hashes) : null;
}

/** Pick an existing tag name. Returns null if no tags exist. */
export async function pickTag(
	harness: WalkHarness,
	rng: SeededRNG,
	opts?: PickerOpts,
): Promise<string | null> {
	if (shouldFuzz(rng, opts)) return fuzzTagName(rng);
	const tagResult = await harness.git("tag");
	const tags = tagResult.stdout.trim().split("\n").filter(Boolean);
	return tags.length > 0 ? rng.pick(tags) : null;
}

/**
 * Pick an existing remote name.
 * When `excludeOrigin` is true, filters out "origin".
 * Returns null if no matching remotes exist.
 */
export async function pickRemote(
	harness: WalkHarness,
	rng: SeededRNG,
	opts?: PickerOpts & { excludeOrigin?: boolean },
): Promise<string | null> {
	if (shouldFuzz(rng, opts)) return fuzzRemoteName(rng);
	const listResult = await harness.git("remote");
	let remotes = listResult.stdout.trim().split("\n").filter(Boolean);
	if (opts?.excludeOrigin) {
		remotes = remotes.filter((r) => r !== "origin");
	}
	return remotes.length > 0 ? rng.pick(remotes) : null;
}

/**
 * Pick an existing remote-tracking branch like `origin/main`.
 * When `excludeLocals` is set, filters out remote branches that already
 * have a matching local branch name.
 */
export async function pickRemoteTrackingBranch(
	harness: WalkHarness,
	rng: SeededRNG,
	opts?: PickerOpts & { remote?: string; excludeLocals?: string[] },
): Promise<string | null> {
	if (shouldFuzz(rng, opts)) {
		const remote = opts?.remote ?? "origin";
		return `${remote}/${fuzzBranchName(rng)}`;
	}
	const result = await harness.git("branch -r");
	const remote = opts?.remote;
	const excludeLocals = new Set(opts?.excludeLocals ?? []);
	const branches = result.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !line.includes(" -> "))
		.filter((line) => (remote ? line.startsWith(`${remote}/`) : true))
		.filter((line) => {
			const slash = line.indexOf("/");
			if (slash < 0) return false;
			const localName = line.slice(slash + 1);
			return !excludeLocals.has(localName);
		});
	return branches.length > 0 ? rng.pick(branches) : null;
}
