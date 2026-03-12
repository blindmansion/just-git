import { describe, expect, test } from "bun:test";
import {
	MergeAction,
	PreconditionRequirement,
	twowayMerge,
} from "../../../src/lib/unpack-trees.ts";
import { HASH_A, HASH_B, HASH_C, makeState, twowayOpts } from "./helpers.ts";

const opts = twowayOpts();

describe("twowayMerge", () => {
	// ── Case 0: no index, old absent, new absent → SKIP ─────────────

	describe("case 0: all absent", () => {
		test("both old and new absent → SKIP, no requirements", () => {
			const state = makeState({
				headHash: null,
				remoteHash: null,
				indexHash: null,
				existsOnDisk: false,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.SKIP);
			expect(result.requirements).toEqual([]);
		});
	});

	// ── Case 2: old present, new absent, no index → SKIP + verify_absent

	describe("case 2: old present, new+index absent", () => {
		test("SKIP with NO_UNTRACKED_REMOVED requirement", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: null,
				indexHash: null,
				existsOnDisk: false,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.SKIP);
			expect(result.requirements).toContain(PreconditionRequirement.NO_UNTRACKED_REMOVED);
		});
	});

	// ── Case 1: no index, old absent, new present → TAKE remote ─────

	describe("case 1: old absent, new present, no index", () => {
		test("TAKE remote", () => {
			const state = makeState({
				headHash: null,
				remoteHash: HASH_A,
				indexHash: null,
				existsOnDisk: false,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.TAKE);
			expect(result.takeFrom).toBe("remote");
		});

		test("requires NO_UNTRACKED", () => {
			const state = makeState({
				headHash: null,
				remoteHash: HASH_A,
				indexHash: null,
				existsOnDisk: false,
			});
			const result = twowayMerge(state, opts);
			expect(result.requirements).toContain(PreconditionRequirement.NO_UNTRACKED);
		});
	});

	// ── Case 3: staged deletion (old present, index absent, new present)

	describe("case 3: staged deletion (old present, no index, new present)", () => {
		test("old == new → SKIP (preserve staged deletion)", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: HASH_A,
				indexHash: null,
				existsOnDisk: false,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.SKIP);
			expect(result.requirements).toEqual([]);
		});

		test("old != new → reject with INDEX_MUST_MATCH_HEAD", () => {
			const state = makeState({
				headHash: HASH_B,
				remoteHash: HASH_A,
				indexHash: null,
				existsOnDisk: false,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.KEEP);
			expect(result.requirements).toContain(PreconditionRequirement.INDEX_MUST_MATCH_HEAD);
		});
	});

	// ── Cases 4/5: index exists, old absent, new absent → KEEP ──────

	describe("cases 4/5: index exists, old+new absent", () => {
		test("staged addition, both trees absent → KEEP", () => {
			const state = makeState({
				headHash: null,
				remoteHash: null,
				indexHash: HASH_A,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.KEEP);
			expect(result.requirements).toEqual([]);
		});
	});

	// ── Cases 6/7: index exists, old absent, new matches index → KEEP

	describe("cases 6/7: old absent, new matches index", () => {
		test("new matches index → KEEP", () => {
			const state = makeState({
				headHash: null,
				remoteHash: HASH_A,
				indexHash: HASH_A,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.KEEP);
			expect(result.requirements).toEqual([]);
		});
	});

	// ── Case 10: index matches old, new absent → DELETE ─────────────

	describe("case 10: index matches old, new absent", () => {
		test("DELETE with WORKTREE_MUST_BE_UPTODATE requirement", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: null,
				indexHash: HASH_A,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.DELETE);
			expect(result.requirements).toContain(PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE);
		});
	});

	// ── Cases 14/15: old == new → KEEP ──────────────────────────────

	describe("cases 14/15: old == new (trees unchanged)", () => {
		test("old == new, index present → KEEP", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: HASH_A,
				indexHash: HASH_B, // index differs — doesn't matter, trees agree
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.KEEP);
			expect(result.requirements).toEqual([]);
		});

		test("old == new, index matches → KEEP", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: HASH_A,
				indexHash: HASH_A,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.KEEP);
			expect(result.requirements).toEqual([]);
		});
	});

	// ── Cases 18/19: index already matches new → KEEP ───────────────

	describe("cases 18/19: index matches new", () => {
		test("index matches new, differs from old → KEEP", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: HASH_B,
				indexHash: HASH_B,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.KEEP);
			expect(result.requirements).toEqual([]);
		});
	});

	// ── Case 20: index matches old, new differs → TAKE remote ───────

	describe("case 20: index matches old, new differs", () => {
		test("TAKE remote with WORKTREE_MUST_BE_UPTODATE", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: HASH_B,
				indexHash: HASH_A,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.TAKE);
			expect(result.takeFrom).toBe("remote");
			expect(result.requirements).toContain(PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE);
		});
	});

	// ── Fallthrough: index matches neither old nor new → reject ─────

	describe("fallthrough: index matches neither", () => {
		test("index differs from both old and new → KEEP with INDEX_MUST_MATCH_HEAD", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: HASH_B,
				indexHash: HASH_C, // matches neither old nor new
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.KEEP);
			expect(result.requirements).toContain(PreconditionRequirement.INDEX_MUST_MATCH_HEAD);
		});
	});

	// ── Conflicted index entry handling ─────────────────────────────

	describe("conflicted index entries (stage > 0)", () => {
		test("conflicted index, trees agree (non-null) → TAKE remote (resolve)", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: HASH_A,
				indexHash: HASH_B,
				indexStage: 1,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.TAKE);
			expect(result.takeFrom).toBe("remote");
			expect(result.requirements).toEqual([]);
		});

		test("conflicted index, trees agree (both null) → DELETE (resolve)", () => {
			const state = makeState({
				headHash: null,
				remoteHash: null,
				indexHash: HASH_B,
				indexStage: 1,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.DELETE);
			expect(result.requirements).toEqual([]);
		});

		test("conflicted index, trees disagree → KEEP with INDEX_MUST_MATCH_HEAD (reject)", () => {
			const state = makeState({
				headHash: HASH_A,
				remoteHash: HASH_B,
				indexHash: HASH_C,
				indexStage: 2,
			});
			const result = twowayMerge(state, opts);
			expect(result.action).toBe(MergeAction.KEEP);
			expect(result.requirements).toContain(PreconditionRequirement.INDEX_MUST_MATCH_HEAD);
		});
	});

	// ── Edge: old absent, new present, index differs from new ───────

	describe("edge: old absent, new present, index differs from new", () => {
		test("staged addition differs from incoming → INDEX_MUST_MATCH_HEAD", () => {
			const state = makeState({
				headHash: null,
				remoteHash: HASH_A,
				indexHash: HASH_B, // staged but different from new
			});
			const result = twowayMerge(state, opts);
			// Falls through to the final case: index matches neither old (null) nor new
			expect(result.requirements).toContain(PreconditionRequirement.INDEX_MUST_MATCH_HEAD);
		});
	});
});
