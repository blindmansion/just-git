import { describe, expect, test } from "bun:test";
import {
	checkSingleRequirement,
	PreconditionRequirement,
	UnpackError,
} from "../../../src/lib/unpack-trees.ts";
import { HASH_A, HASH_B, HASH_C, makeState } from "./helpers.ts";

describe("checkSingleRequirement", () => {
	// ── INDEX_MUST_NOT_EXIST ────────────────────────────────────────

	describe("INDEX_MUST_NOT_EXIST", () => {
		test("passes when no index entry and no file on disk", async () => {
			const state = makeState({
				indexHash: null,
				existsOnDisk: false,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_NOT_EXIST,
				state,
				null,
			);
			expect(result).toBeNull();
		});

		test("fails with WOULD_OVERWRITE when index entry exists", async () => {
			const state = makeState({
				indexHash: HASH_A,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_NOT_EXIST,
				state,
				null,
			);
			expect(result).toBe(UnpackError.WOULD_OVERWRITE);
		});

		test("fails with WOULD_LOSE_UNTRACKED_REMOVED when untracked file on disk", async () => {
			const state = makeState({
				indexHash: null,
				existsOnDisk: true, // file on disk but no index → untracked
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_NOT_EXIST,
				state,
				null,
			);
			expect(result).toBe(UnpackError.WOULD_LOSE_UNTRACKED_REMOVED);
		});
	});

	// ── INDEX_MUST_MATCH_HEAD ───────────────────────────────────────

	describe("INDEX_MUST_MATCH_HEAD", () => {
		test("passes when index matches head", async () => {
			const state = makeState({
				headHash: HASH_A,
				indexHash: HASH_A,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_MATCH_HEAD,
				state,
				HASH_B,
			);
			expect(result).toBeNull();
		});

		test("fails with WOULD_OVERWRITE when index differs from head", async () => {
			const state = makeState({
				headHash: HASH_A,
				indexHash: HASH_B,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_MATCH_HEAD,
				state,
				HASH_C,
			);
			expect(result).toBe(UnpackError.WOULD_OVERWRITE);
		});

		test("fails even when index matches result (no escape hatch)", async () => {
			const state = makeState({
				headHash: HASH_A,
				indexHash: HASH_B, // doesn't match head
			});
			// resultHash = HASH_B matches the index, but INDEX_MUST_MATCH_HEAD
			// has no escape hatch — case 14/18/19 escapes are handled at the
			// classification/merge level, not the requirement level.
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_MATCH_HEAD,
				state,
				HASH_B,
			);
			expect(result).toBe(UnpackError.WOULD_OVERWRITE);
		});

		test("passes when both head and index are null", async () => {
			const state = makeState({
				headHash: null,
				indexHash: null,
				existsOnDisk: false,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_MATCH_HEAD,
				state,
				HASH_A,
			);
			expect(result).toBeNull();
		});
	});

	// ── INDEX_MUST_MATCH_RESULT ─────────────────────────────────────

	describe("INDEX_MUST_MATCH_RESULT", () => {
		test("passes when index is absent (null)", async () => {
			const state = makeState({
				indexHash: null,
				existsOnDisk: false,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_MATCH_RESULT,
				state,
				HASH_A,
			);
			expect(result).toBeNull();
		});

		test("passes when index matches result", async () => {
			const state = makeState({
				indexHash: HASH_A,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_MATCH_RESULT,
				state,
				HASH_A,
			);
			expect(result).toBeNull();
		});

		test("fails with WOULD_OVERWRITE when index differs from result", async () => {
			const state = makeState({
				indexHash: HASH_A,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.INDEX_MUST_MATCH_RESULT,
				state,
				HASH_B,
			);
			expect(result).toBe(UnpackError.WOULD_OVERWRITE);
		});
	});

	// ── WORKTREE_MUST_BE_UPTODATE ───────────────────────────────────

	describe("WORKTREE_MUST_BE_UPTODATE", () => {
		test("passes when worktree matches index (clean)", async () => {
			const state = makeState({
				indexHash: HASH_A,
				existsOnDisk: true,
				worktreeHash: HASH_A, // matches index
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE,
				state,
				HASH_B,
			);
			expect(result).toBeNull();
		});

		test("passes when file not on disk (ENOENT is up-to-date)", async () => {
			const state = makeState({
				indexHash: null,
				existsOnDisk: false,
				worktreeHash: null,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE,
				state,
				null,
			);
			expect(result).toBeNull();
		});

		test("passes when file deleted from disk but still in index (unstaged deletion)", async () => {
			// Real git's verify_uptodate: lstat ENOENT → return 0
			// An unstaged deletion has no content to lose.
			const state = makeState({
				indexHash: HASH_A,
				existsOnDisk: false,
				worktreeHash: null,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE,
				state,
				HASH_B,
			);
			expect(result).toBeNull();
		});

		test("fails with NOT_UPTODATE_FILE when worktree is dirty", async () => {
			const state = makeState({
				indexHash: HASH_A,
				existsOnDisk: true,
				worktreeHash: HASH_B, // dirty: differs from index
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE,
				state,
				HASH_C,
			);
			expect(result).toBe(UnpackError.NOT_UPTODATE_FILE);
		});

		test("escape hatch: passes when worktree matches result (three-way)", async () => {
			const state = makeState({
				indexHash: HASH_A,
				existsOnDisk: true,
				worktreeHash: HASH_B, // dirty: differs from index
			});
			// result is HASH_B → worktree matches result → escape hatch
			const result = await checkSingleRequirement(
				PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE,
				state,
				HASH_B,
				{ allowContentEscapeHatch: true },
			);
			expect(result).toBeNull();
		});

		test("no escape hatch by default: rejects when worktree matches result", async () => {
			const state = makeState({
				indexHash: HASH_A,
				existsOnDisk: true,
				worktreeHash: HASH_B, // dirty: differs from index
			});
			// result is HASH_B → worktree matches result, but no escape hatch
			const result = await checkSingleRequirement(
				PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE,
				state,
				HASH_B,
			);
			expect(result).toBe(UnpackError.NOT_UPTODATE_FILE);
		});

		test("escape hatch: passes when both worktree and result are deleting (three-way)", async () => {
			const state = makeState({
				indexHash: HASH_A,
				existsOnDisk: false,
				worktreeHash: null, // file already deleted
			});
			// result is null → both deleted → escape hatch
			const result = await checkSingleRequirement(
				PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE,
				state,
				null,
				{ allowContentEscapeHatch: true },
			);
			expect(result).toBeNull();
		});

		test("escape hatch does NOT apply when result is null but worktree exists", async () => {
			const state = makeState({
				indexHash: HASH_A,
				existsOnDisk: true,
				worktreeHash: HASH_B, // dirty
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.WORKTREE_MUST_BE_UPTODATE,
				state,
				null,
			);
			expect(result).toBe(UnpackError.NOT_UPTODATE_FILE);
		});
	});

	// ── NO_UNTRACKED ────────────────────────────────────────────────

	describe("NO_UNTRACKED", () => {
		test("passes when no file on disk", async () => {
			const state = makeState({
				indexHash: null,
				existsOnDisk: false,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.NO_UNTRACKED,
				state,
				HASH_A,
			);
			expect(result).toBeNull();
		});

		test("passes when file is tracked (in index)", async () => {
			const state = makeState({
				indexHash: HASH_A,
				existsOnDisk: true,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.NO_UNTRACKED,
				state,
				HASH_B,
			);
			expect(result).toBeNull();
		});

		test("fails with WOULD_LOSE_UNTRACKED_OVERWRITTEN when untracked file exists", async () => {
			const state = makeState({
				indexHash: null,
				existsOnDisk: true, // untracked: exists on disk, not in index
				worktreeHash: HASH_C,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.NO_UNTRACKED,
				state,
				HASH_A,
			);
			expect(result).toBe(UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN);
		});

		test("rejects even when untracked worktree matches result (no escape hatch)", async () => {
			// git's verify_absent / check_ok_to_remove has no content-matching
			// escape hatch — rejects unconditionally for untracked files.
			const state = makeState({
				indexHash: null,
				existsOnDisk: true,
				worktreeHash: HASH_A, // untracked, content matches result
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.NO_UNTRACKED,
				state,
				HASH_A,
			);
			expect(result).toBe(UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN);
		});

		test("passes when untracked file is ignored", async () => {
			const state = makeState({
				indexHash: null,
				existsOnDisk: true,
				ignoredOnDisk: true,
				worktreeHash: HASH_A,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.NO_UNTRACKED,
				state,
				HASH_B,
			);
			expect(result).toBeNull();
		});
	});

	describe("NO_UNTRACKED_REMOVED", () => {
		test("passes when ignored untracked file would be removed", async () => {
			const state = makeState({
				indexHash: null,
				existsOnDisk: true,
				ignoredOnDisk: true,
				worktreeHash: HASH_C,
			});
			const result = await checkSingleRequirement(
				PreconditionRequirement.NO_UNTRACKED_REMOVED,
				state,
				null,
			);
			expect(result).toBeNull();
		});
	});
});
