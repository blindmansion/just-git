import { describe, expect, test } from "bun:test";
import type { RejectedPath } from "../../../src/lib/unpack-trees.ts";
import { formatErrors, UnpackError } from "../../../src/lib/unpack-trees.ts";

describe("formatErrors", () => {
	const checkoutOpts = {
		errorExitCode: 1,
		operationName: "checkout",
		allowUntrackedEscapeHatch: true,
	};

	const mergeOpts = {
		errorExitCode: 2,
		operationName: "merge",
		allowUntrackedEscapeHatch: false,
	};

	// ── Local changes (WOULD_OVERWRITE + NOT_UPTODATE_FILE) ─────────

	test("formats WOULD_OVERWRITE errors as local changes", () => {
		const rejected: RejectedPath[] = [{ path: "file.txt", error: UnpackError.WOULD_OVERWRITE }];
		const result = formatErrors(rejected, checkoutOpts);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"Your local changes to the following files would be overwritten by checkout",
		);
		expect(result.stderr).toContain("\tfile.txt");
		expect(result.stderr).toContain("Please commit your changes or stash them before you checkout");
	});

	test("formats NOT_UPTODATE_FILE errors as local changes", () => {
		const rejected: RejectedPath[] = [{ path: "dirty.txt", error: UnpackError.NOT_UPTODATE_FILE }];
		const result = formatErrors(rejected, checkoutOpts);
		expect(result.stderr).toContain(
			"Your local changes to the following files would be overwritten by checkout",
		);
		expect(result.stderr).toContain("\tdirty.txt");
	});

	test("WOULD_OVERWRITE and NOT_UPTODATE_FILE produce separate blocks", () => {
		const rejected: RejectedPath[] = [
			{ path: "b.txt", error: UnpackError.WOULD_OVERWRITE },
			{ path: "a.txt", error: UnpackError.NOT_UPTODATE_FILE },
		];
		const result = formatErrors(rejected, checkoutOpts);
		// Both should appear in separate "Your local changes" blocks
		expect(result.stderr).toContain("\ta.txt");
		expect(result.stderr).toContain("\tb.txt");
		// Two separate "Your local changes" headers (matching git's display_error_msgs)
		const headerCount = (result.stderr.match(/Your local changes/g) || []).length;
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
		const result = formatErrors(rejected, mergeOpts);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			"The following untracked working tree files would be overwritten by merge",
		);
		expect(result.stderr).toContain("\tuntracked.txt");
		expect(result.stderr).toContain("Please move or remove them before you merge");
	});

	// ── Untracked removed ───────────────────────────────────────────

	test("formats WOULD_LOSE_UNTRACKED_REMOVED errors", () => {
		const rejected: RejectedPath[] = [
			{
				path: "gone.txt",
				error: UnpackError.WOULD_LOSE_UNTRACKED_REMOVED,
			},
		];
		const result = formatErrors(rejected, checkoutOpts);
		expect(result.stderr).toContain(
			"The following untracked working tree files would be removed by checkout",
		);
		expect(result.stderr).toContain("\tgone.txt");
		expect(result.stderr).toContain("Please move or remove them before you checkout");
	});

	// ── Paths sorted within each group ──────────────────────────────

	test("sorts paths within each error group", () => {
		const rejected: RejectedPath[] = [
			{ path: "z.txt", error: UnpackError.WOULD_OVERWRITE },
			{ path: "a.txt", error: UnpackError.WOULD_OVERWRITE },
			{ path: "m.txt", error: UnpackError.WOULD_OVERWRITE },
		];
		const result = formatErrors(rejected, checkoutOpts);
		const aIdx = result.stderr.indexOf("\ta.txt");
		const mIdx = result.stderr.indexOf("\tm.txt");
		const zIdx = result.stderr.indexOf("\tz.txt");
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
		const result = formatErrors(rejected, checkoutOpts);
		expect(result.stderr).toContain("Your local changes");
		expect(result.stderr).toContain("would be overwritten by checkout:\n\tuntracked.txt");
		expect(result.stderr).toContain("would be removed by checkout:\n\tremoved.txt");
	});

	// ── Empty errors → empty output ─────────────────────────────────

	test("empty rejected list produces empty stderr", () => {
		const result = formatErrors([], checkoutOpts);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe("");
		expect(result.exitCode).toBe(1);
	});

	// ── Uses operationName from options ──────────────────────────────

	test("uses operationName in error messages", () => {
		const rejected: RejectedPath[] = [{ path: "file.txt", error: UnpackError.WOULD_OVERWRITE }];
		const result = formatErrors(rejected, mergeOpts);
		expect(result.stderr).toContain("overwritten by merge");
		expect(result.stderr).toContain("before you merge");
	});

	// ── stdout is always empty ──────────────────────────────────────

	test("stdout is always empty", () => {
		const rejected: RejectedPath[] = [{ path: "file.txt", error: UnpackError.WOULD_OVERWRITE }];
		const result = formatErrors(rejected, checkoutOpts);
		expect(result.stdout).toBe("");
	});
});
