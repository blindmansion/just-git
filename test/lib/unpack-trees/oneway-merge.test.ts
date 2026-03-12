import { describe, expect, test } from "bun:test";
import {
	MergeAction,
	onewayMerge,
	PreconditionRequirement,
} from "../../../src/lib/unpack-trees.ts";
import { HASH_A, HASH_B, makeState, onewayOpts } from "./helpers.ts";

describe("onewayMerge", () => {
	// ── Target absent ───────────────────────────────────────────────

	test("target absent → DELETE", () => {
		const state = makeState({
			remoteHash: null,
			indexHash: HASH_A,
		});
		const result = onewayMerge(state, onewayOpts());
		expect(result.action).toBe(MergeAction.DELETE);
	});

	test("target absent, non-reset → requires WORKTREE_MUST_BE_UPTODATE", () => {
		const state = makeState({
			remoteHash: null,
			indexHash: HASH_A,
		});
		const result = onewayMerge(state, onewayOpts({ reset: false }));
		expect(result.action).toBe(MergeAction.DELETE);
		expect(result.requirements).toContain(PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE);
	});

	test("target absent, reset mode → no requirements", () => {
		const state = makeState({
			remoteHash: null,
			indexHash: HASH_A,
		});
		const result = onewayMerge(state, onewayOpts({ reset: true }));
		expect(result.action).toBe(MergeAction.DELETE);
		expect(result.requirements).toEqual([]);
	});

	// ── Target present, index matches ───────────────────────────────

	test("target present, index matches target → KEEP", () => {
		const state = makeState({
			remoteHash: HASH_A,
			indexHash: HASH_A,
		});
		const result = onewayMerge(state, onewayOpts());
		expect(result.action).toBe(MergeAction.KEEP);
		expect(result.requirements).toEqual([]);
	});

	// ── Target present, index differs ───────────────────────────────

	test("target present, index differs → TAKE remote", () => {
		const state = makeState({
			remoteHash: HASH_A,
			indexHash: HASH_B,
		});
		const result = onewayMerge(state, onewayOpts());
		expect(result.action).toBe(MergeAction.TAKE);
		expect(result.takeFrom).toBe("remote");
	});

	test("target present, index differs, non-reset → requires WORKTREE_MUST_BE_UPTODATE", () => {
		const state = makeState({
			remoteHash: HASH_A,
			indexHash: HASH_B,
		});
		const result = onewayMerge(state, onewayOpts({ reset: false }));
		expect(result.requirements).toContain(PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE);
	});

	test("target present, index differs, reset mode → no requirements", () => {
		const state = makeState({
			remoteHash: HASH_A,
			indexHash: HASH_B,
		});
		const result = onewayMerge(state, onewayOpts({ reset: true }));
		expect(result.action).toBe(MergeAction.TAKE);
		expect(result.requirements).toEqual([]);
	});

	// ── Target present, index absent ────────────────────────────────

	test("target present, no index entry → TAKE remote", () => {
		const state = makeState({
			remoteHash: HASH_A,
			indexHash: null,
			existsOnDisk: false,
		});
		const result = onewayMerge(state, onewayOpts());
		expect(result.action).toBe(MergeAction.TAKE);
		expect(result.takeFrom).toBe("remote");
	});

	// ── Both absent ─────────────────────────────────────────────────

	test("target absent, index absent → SKIP (nothing to do)", () => {
		const state = makeState({
			remoteHash: null,
			indexHash: null,
			existsOnDisk: false,
		});
		const result = onewayMerge(state, onewayOpts());
		expect(result.action).toBe(MergeAction.SKIP);
	});

	test("target absent, index absent, untracked file → SKIP (preserves untracked)", () => {
		const state = makeState({
			remoteHash: null,
			indexHash: null,
			existsOnDisk: true,
		});
		const result = onewayMerge(state, onewayOpts());
		expect(result.action).toBe(MergeAction.SKIP);
	});
});
