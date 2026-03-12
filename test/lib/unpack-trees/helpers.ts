/**
 * Test helpers for unpack-trees pure function tests.
 *
 * Provides deterministic fake hashes and PathState builders so tests
 * can focus on the merge logic without touching the filesystem.
 */

import type { ObjectId } from "../../../src/lib/types.ts";
import type { PathState, UnpackOptions } from "../../../src/lib/unpack-trees.ts";
import { onewayMerge, twowayMerge } from "../../../src/lib/unpack-trees.ts";

// ── Deterministic fake hashes ───────────────────────────────────────

/**
 * Generate a deterministic 40-char hex hash from a label.
 * e.g. fakeHash("a") always returns the same value.
 */
function fakeHash(label: string): ObjectId {
	return new Bun.CryptoHasher("sha1").update(`fake-object-${label}`).digest("hex");
}

// Pre-computed hashes for common test values.
// These are distinct from each other by construction.
export const HASH_A = fakeHash("A");
export const HASH_B = fakeHash("B");
export const HASH_C = fakeHash("C");

// ── PathState builder ───────────────────────────────────────────────

interface PathStateInput {
	path?: string;
	baseHash?: ObjectId | null;
	headHash?: ObjectId | null;
	remoteHash?: ObjectId | null;
	indexHash?: ObjectId | null;
	indexStage?: number;
	existsOnDisk?: boolean;
	ignoredOnDisk?: boolean;
	worktreeHash?: ObjectId | null;
	headMode?: string | null;
	remoteMode?: string | null;
}

// Input still accepts `ignoredOnDisk` boolean for convenience;
// the builder wraps it in a lazy getter to match PathState.

/**
 * Build a PathState with sensible defaults.
 * The `getWorktreeHash` is backed by the provided `worktreeHash` value
 * (defaults to matching indexHash, i.e. a clean worktree).
 */
export function makeState(input: PathStateInput = {}): PathState {
	const indexHash = input.indexHash ?? null;
	const existsOnDisk = input.existsOnDisk ?? indexHash !== null;
	// Default: worktree matches index (clean worktree)
	const worktreeHash = input.worktreeHash !== undefined ? input.worktreeHash : indexHash;

	const ignoredOnDisk = input.ignoredOnDisk ?? false;

	return {
		path: input.path ?? "file.txt",
		baseHash: input.baseHash ?? null,
		headHash: input.headHash ?? null,
		remoteHash: input.remoteHash ?? null,
		indexHash,
		indexStage: input.indexStage ?? 0,
		existsOnDisk,
		isIgnoredOnDisk: async () => ignoredOnDisk,
		getWorktreeHash: async () => worktreeHash,
		headMode: input.headMode ?? (input.headHash ? "100644" : null),
		remoteMode: input.remoteMode ?? (input.remoteHash ? "100644" : null),
	};
}

// ── UnpackOptions builder ───────────────────────────────────────────

interface UnpackOptsInput {
	reset?: boolean;
	updateWorktree?: boolean;
	operationName?: string;
	errorExitCode?: number;
}

/**
 * Build UnpackOptions for one-way merge tests.
 */
export function onewayOpts(input: UnpackOptsInput = {}): UnpackOptions {
	return {
		mergeFn: onewayMerge,
		updateWorktree: input.updateWorktree ?? true,
		reset: input.reset ?? false,
		errorExitCode: input.errorExitCode ?? 128,
		operationName: input.operationName ?? "reset",
	};
}

/**
 * Build UnpackOptions for two-way merge tests.
 */
export function twowayOpts(input: UnpackOptsInput = {}): UnpackOptions {
	return {
		mergeFn: twowayMerge,
		updateWorktree: input.updateWorktree ?? true,
		reset: input.reset ?? false,
		errorExitCode: input.errorExitCode ?? 1,
		operationName: input.operationName ?? "checkout",
	};
}
