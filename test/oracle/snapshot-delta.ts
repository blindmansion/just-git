import type { GitSnapshot } from "./capture";

export type SnapshotDelta = Partial<GitSnapshot>;

export const EMPTY_SNAPSHOT: GitSnapshot = {
	head: { headRef: null, headSha: null },
	refs: [],
	index: [],
	operation: { operation: null, stateHash: null },
	workTreeHash: "",
	stashHashes: [],
};

const SNAPSHOT_KEYS: (keyof GitSnapshot)[] = [
	"head",
	"refs",
	"index",
	"operation",
	"workTreeHash",
	"stashHashes",
];

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
