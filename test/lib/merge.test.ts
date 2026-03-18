import { describe, expect, test } from "bun:test";
import { findAllMergeBases } from "../../src/lib/merge";
import { mergeOrtNonRecursive } from "../../src/lib/merge-ort";
import { readCommit } from "../../src/lib/object-db";
import { resolveRef } from "../../src/lib/refs";
import { findRepo } from "../../src/lib/repo";
import type { GitContext, ObjectId } from "../../src/lib/types";
import { EMPTY_REPO, envAt } from "../fixtures";
import { createTestBash } from "../util";

async function findMergeBase(ctx: GitContext, a: ObjectId, b: ObjectId): Promise<ObjectId | null> {
	const bases = await findAllMergeBases(ctx, a, b);
	return bases[0] ?? null;
}

// ── mergeOrtNonRecursive ────────────────────────────────────────────

describe("mergeOrtNonRecursive", () => {
	test("clean merge — no overlapping changes", async () => {
		const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		// Create feature branch
		await bash.exec("git branch feature");

		// Add a file on main
		await bash.fs.writeFile("/repo/main-file.txt", "main content\n");
		await bash.exec("git add main-file.txt");
		await bash.exec('git commit -m "main adds file"');

		// Switch to feature and add a different file
		await bash.exec("git checkout feature");
		await bash.fs.writeFile("/repo/feature-file.txt", "feature content\n");
		await bash.exec("git add feature-file.txt");
		await bash.exec('git commit -m "feature adds file"');

		const gitCtx = (await findRepo(bash.fs, "/repo"))!;
		const mainHash = (await resolveRef(gitCtx, "refs/heads/main"))!;
		const featureHash = (await resolveRef(gitCtx, "refs/heads/feature"))!;

		const baseHash = (await findMergeBase(gitCtx, mainHash, featureHash))!;
		const baseCommit = await readCommit(gitCtx, baseHash);
		const mainCommit = await readCommit(gitCtx, mainHash);
		const featureCommit = await readCommit(gitCtx, featureHash);

		const result = await mergeOrtNonRecursive(
			gitCtx,
			baseCommit.tree,
			mainCommit.tree,
			featureCommit.tree,
		);

		expect(result.conflicts).toHaveLength(0);
		// Should have: README.md, main-file.txt, feature-file.txt
		const paths = result.entries.map((e) => e.path).sort();
		expect(paths).toEqual(["README.md", "feature-file.txt", "main-file.txt"]);
		// All stage 0
		expect(result.entries.every((e) => e.stage === 0)).toBe(true);
	});

	test("content conflict — both sides modify same file differently", async () => {
		const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		await bash.exec("git branch feature");

		// Modify README on main
		await bash.fs.writeFile("/repo/README.md", "# Main Changes\n");
		await bash.exec("git add README.md");
		await bash.exec('git commit -m "main changes"');

		// Modify README on feature differently
		await bash.exec("git checkout feature");
		await bash.fs.writeFile("/repo/README.md", "# Feature Changes\n");
		await bash.exec("git add README.md");
		await bash.exec('git commit -m "feature changes"');

		const gitCtx = (await findRepo(bash.fs, "/repo"))!;
		const mainHash = (await resolveRef(gitCtx, "refs/heads/main"))!;
		const featureHash = (await resolveRef(gitCtx, "refs/heads/feature"))!;

		const baseHash = (await findMergeBase(gitCtx, mainHash, featureHash))!;
		const baseCommit = await readCommit(gitCtx, baseHash);
		const mainCommit = await readCommit(gitCtx, mainHash);
		const featureCommit = await readCommit(gitCtx, featureHash);

		const result = await mergeOrtNonRecursive(
			gitCtx,
			baseCommit.tree,
			mainCommit.tree,
			featureCommit.tree,
		);

		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]!.path).toBe("README.md");
		expect(result.conflicts[0]!.reason).toBe("content");

		// Should have stages 1, 2, 3 for the conflicted file
		const readmeEntries = result.entries.filter((e) => e.path === "README.md");
		expect(readmeEntries).toHaveLength(3);
		expect(readmeEntries.map((e) => e.stage).sort()).toEqual([1, 2, 3]);
	});

	test("delete/modify conflict — ours deletes, theirs modifies", async () => {
		const bash = createTestBash({
			files: {
				"/repo/README.md": "# Project\n",
				"/repo/keep.txt": "keep\n",
			},
			env: envAt("100"),
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		await bash.exec("git branch feature");

		// Delete README on main
		await bash.fs.rm("/repo/README.md");
		await bash.exec("git add README.md");
		await bash.exec('git commit -m "main deletes readme"');

		// Modify README on feature
		await bash.exec("git checkout feature");
		await bash.fs.writeFile("/repo/README.md", "# Updated Project\n");
		await bash.exec("git add README.md");
		await bash.exec('git commit -m "feature updates readme"');

		const gitCtx = (await findRepo(bash.fs, "/repo"))!;
		const mainHash = (await resolveRef(gitCtx, "refs/heads/main"))!;
		const featureHash = (await resolveRef(gitCtx, "refs/heads/feature"))!;
		const baseHash = (await findMergeBase(gitCtx, mainHash, featureHash))!;

		const baseCommit = await readCommit(gitCtx, baseHash);
		const mainCommit = await readCommit(gitCtx, mainHash);
		const featureCommit = await readCommit(gitCtx, featureHash);

		const result = await mergeOrtNonRecursive(
			gitCtx,
			baseCommit.tree,
			mainCommit.tree,
			featureCommit.tree,
		);

		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]!.reason).toBe("delete-modify");

		// Should have stage 1 (base) and stage 3 (theirs, the modifier)
		const readmeEntries = result.entries.filter((e) => e.path === "README.md");
		const stages = readmeEntries.map((e) => e.stage).sort();
		expect(stages).toEqual([1, 3]);
	});

	test("add/add conflict — both sides add same file with different content", async () => {
		const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		await bash.exec("git branch feature");

		// Add new.txt on main
		await bash.fs.writeFile("/repo/new.txt", "main version\n");
		await bash.exec("git add new.txt");
		await bash.exec('git commit -m "main adds new.txt"');

		// Add new.txt on feature with different content
		await bash.exec("git checkout feature");
		await bash.fs.writeFile("/repo/new.txt", "feature version\n");
		await bash.exec("git add new.txt");
		await bash.exec('git commit -m "feature adds new.txt"');

		const gitCtx = (await findRepo(bash.fs, "/repo"))!;
		const mainHash = (await resolveRef(gitCtx, "refs/heads/main"))!;
		const featureHash = (await resolveRef(gitCtx, "refs/heads/feature"))!;
		const baseHash = (await findMergeBase(gitCtx, mainHash, featureHash))!;

		const baseCommit = await readCommit(gitCtx, baseHash);
		const mainCommit = await readCommit(gitCtx, mainHash);
		const featureCommit = await readCommit(gitCtx, featureHash);

		const result = await mergeOrtNonRecursive(
			gitCtx,
			baseCommit.tree,
			mainCommit.tree,
			featureCommit.tree,
		);

		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]!.reason).toBe("add-add");

		// Stages 2 (ours) and 3 (theirs) — no base
		const newEntries = result.entries.filter((e) => e.path === "new.txt");
		const stages = newEntries.map((e) => e.stage).sort();
		expect(stages).toEqual([2, 3]);
	});

	test("both sides make the same change — false conflict", async () => {
		const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		await bash.exec("git branch feature");

		// Both sides change README identically
		await bash.fs.writeFile("/repo/README.md", "# Same Change\n");
		await bash.exec("git add README.md");
		await bash.exec('git commit -m "main changes"');

		await bash.exec("git checkout feature");
		await bash.fs.writeFile("/repo/README.md", "# Same Change\n");
		await bash.exec("git add README.md");
		await bash.exec('git commit -m "feature changes"');

		const gitCtx = (await findRepo(bash.fs, "/repo"))!;
		const mainHash = (await resolveRef(gitCtx, "refs/heads/main"))!;
		const featureHash = (await resolveRef(gitCtx, "refs/heads/feature"))!;
		const baseHash = (await findMergeBase(gitCtx, mainHash, featureHash))!;

		const baseCommit = await readCommit(gitCtx, baseHash);
		const mainCommit = await readCommit(gitCtx, mainHash);
		const featureCommit = await readCommit(gitCtx, featureHash);

		const result = await mergeOrtNonRecursive(
			gitCtx,
			baseCommit.tree,
			mainCommit.tree,
			featureCommit.tree,
		);

		// Same content → same blob hash → no conflict (false conflict resolved)
		expect(result.conflicts).toHaveLength(0);
		expect(result.entries.every((e) => e.stage === 0)).toBe(true);
	});

	test("file added only on one side — no conflict", async () => {
		const bash = createTestBash({ files: EMPTY_REPO, env: envAt("100") });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		await bash.exec("git branch feature");

		// Add file only on feature
		await bash.exec("git checkout feature");
		await bash.fs.writeFile("/repo/new-feature.txt", "new\n");
		await bash.exec("git add new-feature.txt");
		await bash.exec('git commit -m "feature adds file"');

		const gitCtx = (await findRepo(bash.fs, "/repo"))!;
		const mainHash = (await resolveRef(gitCtx, "refs/heads/main"))!;
		const featureHash = (await resolveRef(gitCtx, "refs/heads/feature"))!;
		const baseHash = (await findMergeBase(gitCtx, mainHash, featureHash))!;

		const baseCommit = await readCommit(gitCtx, baseHash);
		const mainCommit = await readCommit(gitCtx, mainHash);
		const featureCommit = await readCommit(gitCtx, featureHash);

		const result = await mergeOrtNonRecursive(
			gitCtx,
			baseCommit.tree,
			mainCommit.tree,
			featureCommit.tree,
		);

		expect(result.conflicts).toHaveLength(0);
		const paths = result.entries.map((e) => e.path).sort();
		expect(paths).toContain("new-feature.txt");
	});

	test("content merge — both sides edit different parts of same file", async () => {
		const bash = createTestBash({
			files: {
				"/repo/file.txt": "line1\nline2\nline3\nline4\nline5\n",
			},
			env: envAt("100"),
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		await bash.exec("git branch feature");

		// Main changes line 1
		await bash.fs.writeFile("/repo/file.txt", "MAIN\nline2\nline3\nline4\nline5\n");
		await bash.exec("git add file.txt");
		await bash.exec('git commit -m "main edits"');

		// Feature changes line 5
		await bash.exec("git checkout feature");
		await bash.fs.writeFile("/repo/file.txt", "line1\nline2\nline3\nline4\nFEATURE\n");
		await bash.exec("git add file.txt");
		await bash.exec('git commit -m "feature edits"');

		const gitCtx = (await findRepo(bash.fs, "/repo"))!;
		const mainHash = (await resolveRef(gitCtx, "refs/heads/main"))!;
		const featureHash = (await resolveRef(gitCtx, "refs/heads/feature"))!;
		const baseHash = (await findMergeBase(gitCtx, mainHash, featureHash))!;

		const baseCommit = await readCommit(gitCtx, baseHash);
		const mainCommit = await readCommit(gitCtx, mainHash);
		const featureCommit = await readCommit(gitCtx, featureHash);

		const result = await mergeOrtNonRecursive(
			gitCtx,
			baseCommit.tree,
			mainCommit.tree,
			featureCommit.tree,
		);

		// Non-overlapping edits should merge cleanly
		expect(result.conflicts).toHaveLength(0);
		const fileEntry = result.entries.find((e) => e.path === "file.txt");
		expect(fileEntry).toBeDefined();
		expect(fileEntry!.stage).toBe(0);
	});
});
