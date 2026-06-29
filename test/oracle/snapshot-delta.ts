import type { GitSnapshot } from "./capture";

export type SnapshotDelta = Partial<GitSnapshot>;

/**
 * The initial accumulator and the placeholder sentinel. A placeholder step
 * (an intermediate command in a multi-command action, with no real snapshot)
 * is stored as this object; its main worktree's empty `workTreeHash` ("") is
 * the sentinel `isPlaceholderDelta` keys on. A real capture never produces an
 * empty hash — even an empty worktree hashes to the SHA-1 of no input.
 */
export const EMPTY_SNAPSHOT: GitSnapshot = {
	refs: [],
	stashHashes: [],
	worktrees: [
		{
			id: "main",
			path: ".",
			headRef: null,
			headSha: null,
			index: [],
			workTreeHash: "",
			operation: null,
			operationStateHash: null,
			locked: false,
			lockReason: null,
			prunable: null,
			checkoutExists: true,
		},
	],
};

const SNAPSHOT_KEYS: (keyof GitSnapshot)[] = ["refs", "stashHashes", "worktrees"];

export function diffSnapshot(prev: GitSnapshot, curr: GitSnapshot): SnapshotDelta {
	const delta: SnapshotDelta = {};
	for (const key of SNAPSHOT_KEYS) {
		const prevVal = prev[key];
		const currVal = curr[key];
		if (typeof currVal === "string") {
			if (prevVal !== currVal) {
				(delta as Record<string, unknown>)[key] = currVal;
			}
		} else {
			if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
				(delta as Record<string, unknown>)[key] = currVal;
			}
		}
	}
	return delta;
}

export function applyDelta(prev: GitSnapshot, delta: SnapshotDelta): GitSnapshot {
	return { ...prev, ...delta };
}

/**
 * Whether a stored delta is a placeholder (a multi-command action's
 * intermediate step). Detected via the main worktree's empty `workTreeHash`
 * sentinel; a delta that simply doesn't touch `worktrees` is not a placeholder.
 */
export function isPlaceholderDelta(delta: SnapshotDelta): boolean {
	const main = delta.worktrees?.find((w) => w.id === "main");
	return main?.workTreeHash === "";
}
