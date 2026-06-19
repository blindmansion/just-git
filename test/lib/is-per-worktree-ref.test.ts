import { describe, expect, test } from "bun:test";
import { isPerWorktreeRef } from "../../src/lib/ref-classify.ts";

describe("isPerWorktreeRef", () => {
	const cases: Array<[string, boolean]> = [
		// Uppercase pseudo-refs directly under the git dir — per-worktree.
		["HEAD", true],
		["ORIG_HEAD", true],
		["MERGE_HEAD", true],
		["CHERRY_PICK_HEAD", true],
		["REVERT_HEAD", true],
		["FETCH_HEAD", true],
		// Per-worktree ref namespaces.
		["refs/bisect/bad", true],
		["refs/worktree/private", true],
		["refs/rewritten/onto", true],
		// Shared refs.
		["refs/heads/main", false],
		["refs/tags/v1", false],
		["refs/remotes/origin/main", false],
		["refs/stash", false],
		["refs/notes/commits", false],
		// A lowercase loose file under the git dir must not be mistaken for a
		// per-worktree pseudo-ref (pins the all-uppercase branch).
		["config", false],
	];

	test.each(cases)("%s -> %p", (name, expected) => {
		expect(isPerWorktreeRef(name)).toBe(expected);
	});
});
