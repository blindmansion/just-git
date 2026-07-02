import { describe, expect, test } from "bun:test";
import { renderMergeAbortError, renderUnpackErrors } from "../../../src/format/unpack-trees.ts";
import type { RejectedPath } from "../../../src/lib/worktree/unpack-trees.ts";
import { UnpackError } from "../../../src/lib/worktree/unpack-trees.ts";

describe("renderUnpackErrors", () => {
	const checkoutCtx = { operationName: "checkout" };
	const mergeCtx = { operationName: "merge" };

	// ── Local changes (WOULD_OVERWRITE + NOT_UPTODATE_FILE) ─────────

	test("formats WOULD_OVERWRITE errors as local changes", () => {
		const rejected: RejectedPath[] = [{ path: "file.txt", error: UnpackError.WOULD_OVERWRITE }];
		const stderr = renderUnpackErrors(rejected, checkoutCtx);
		expect(stderr).toContain(
			"Your local changes to the following files would be overwritten by checkout",
		);
		expect(stderr).toContain("\tfile.txt");
		expect(stderr).toContain("Please commit your changes or stash them before you checkout");
	});

	test("formats NOT_UPTODATE_FILE errors as local changes", () => {
		const rejected: RejectedPath[] = [{ path: "dirty.txt", error: UnpackError.NOT_UPTODATE_FILE }];
		const stderr = renderUnpackErrors(rejected, checkoutCtx);
		expect(stderr).toContain(
			"Your local changes to the following files would be overwritten by checkout",
		);
		expect(stderr).toContain("\tdirty.txt");
	});

	test("WOULD_OVERWRITE and NOT_UPTODATE_FILE produce separate blocks", () => {
		const rejected: RejectedPath[] = [
			{ path: "b.txt", error: UnpackError.WOULD_OVERWRITE },
			{ path: "a.txt", error: UnpackError.NOT_UPTODATE_FILE },
		];
		const stderr = renderUnpackErrors(rejected, checkoutCtx);
		// Both should appear in separate "Your local changes" blocks
		expect(stderr).toContain("\ta.txt");
		expect(stderr).toContain("\tb.txt");
		// Two separate "Your local changes" headers (matching git's display_error_msgs)
		const headerCount = (stderr.match(/Your local changes/g) || []).length;
		expect(headerCount).toBe(2);
	});

	// ── Untracked overwritten ───────────────────────────────────────

	test("formats WOULD_LOSE_UNTRACKED_OVERWRITTEN errors", () => {
		const rejected: RejectedPath[] = [
			{
				path: "untracked.txt",
				error: UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN,
			},
		];
		const stderr = renderUnpackErrors(rejected, mergeCtx);
		expect(stderr).toContain(
			"The following untracked working tree files would be overwritten by merge",
		);
		expect(stderr).toContain("\tuntracked.txt");
		expect(stderr).toContain("Please move or remove them before you merge");
	});

	// ── Untracked removed ───────────────────────────────────────────

	test("formats WOULD_LOSE_UNTRACKED_REMOVED errors", () => {
		const rejected: RejectedPath[] = [
			{
				path: "gone.txt",
				error: UnpackError.WOULD_LOSE_UNTRACKED_REMOVED,
			},
		];
		const stderr = renderUnpackErrors(rejected, checkoutCtx);
		expect(stderr).toContain(
			"The following untracked working tree files would be removed by checkout",
		);
		expect(stderr).toContain("\tgone.txt");
		expect(stderr).toContain("Please move or remove them before you checkout");
	});

	// ── Paths sorted within each group ──────────────────────────────

	test("sorts paths within each error group", () => {
		const rejected: RejectedPath[] = [
			{ path: "z.txt", error: UnpackError.WOULD_OVERWRITE },
			{ path: "a.txt", error: UnpackError.WOULD_OVERWRITE },
			{ path: "m.txt", error: UnpackError.WOULD_OVERWRITE },
		];
		const stderr = renderUnpackErrors(rejected, checkoutCtx);
		const aIdx = stderr.indexOf("\ta.txt");
		const mIdx = stderr.indexOf("\tm.txt");
		const zIdx = stderr.indexOf("\tz.txt");
		expect(aIdx).toBeLessThan(mIdx);
		expect(mIdx).toBeLessThan(zIdx);
	});

	// ── Multiple error groups all included ──────────────────────────

	test("includes all non-empty error groups", () => {
		const rejected: RejectedPath[] = [
			{ path: "staged.txt", error: UnpackError.WOULD_OVERWRITE },
			{
				path: "untracked.txt",
				error: UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN,
			},
			{
				path: "removed.txt",
				error: UnpackError.WOULD_LOSE_UNTRACKED_REMOVED,
			},
		];
		const stderr = renderUnpackErrors(rejected, checkoutCtx);
		expect(stderr).toContain("Your local changes");
		expect(stderr).toContain("would be overwritten by checkout:\n\tuntracked.txt");
		expect(stderr).toContain("would be removed by checkout:\n\tremoved.txt");
	});

	// ── Empty errors → empty output ─────────────────────────────────

	test("empty rejected list produces empty stderr", () => {
		expect(renderUnpackErrors([], checkoutCtx)).toBe("");
	});

	// ── actionHint overrides the "before you <action>" text ──────────

	test("uses actionHint for the fix line when provided", () => {
		const rejected: RejectedPath[] = [{ path: "file.txt", error: UnpackError.WOULD_OVERWRITE }];
		const stderr = renderUnpackErrors(rejected, {
			operationName: "checkout",
			actionHint: "switch branches",
		});
		expect(stderr).toContain("overwritten by checkout");
		expect(stderr).toContain("before you switch branches");
	});

	// ── Uses operationName from context ─────────────────────────────

	test("uses operationName in error messages", () => {
		const rejected: RejectedPath[] = [{ path: "file.txt", error: UnpackError.WOULD_OVERWRITE }];
		const stderr = renderUnpackErrors(rejected, mergeCtx);
		expect(stderr).toContain("overwritten by merge");
		expect(stderr).toContain("before you merge");
	});
});

describe("renderMergeAbortError", () => {
	test("formats NOT_UPTODATE_FILE with the reset-index trailer", () => {
		const rejected: RejectedPath[] = [{ path: "dirty.txt", error: UnpackError.NOT_UPTODATE_FILE }];
		const stderr = renderMergeAbortError(rejected, "HEAD");
		expect(stderr).toBe(
			"error: Entry 'dirty.txt' not uptodate. Cannot merge.\n" +
				"fatal: Could not reset index file to revision 'HEAD'.\n",
		);
	});

	test("formats WOULD_LOSE_UNTRACKED_OVERWRITTEN with the given revision name", () => {
		const rejected: RejectedPath[] = [
			{ path: "u.txt", error: UnpackError.WOULD_LOSE_UNTRACKED_OVERWRITTEN },
		];
		const stderr = renderMergeAbortError(rejected, "abc123");
		expect(stderr).toContain(
			"error: Untracked working tree file 'u.txt' would be overwritten by merge.\n",
		);
		expect(stderr).toContain("fatal: Could not reset index file to revision 'abc123'.\n");
	});

	test("returns empty string when no error kind applies", () => {
		const rejected: RejectedPath[] = [{ path: "x.txt", error: UnpackError.WOULD_OVERWRITE }];
		expect(renderMergeAbortError(rejected, "HEAD")).toBe("");
	});
});
