import { describe, expect, test } from "bun:test";
import type { Identity, GitRepo } from "../../src/lib/types.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import { diffCommits } from "../../src/repo/diffing.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";

const ID: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function idAt(ts: number): Identity {
	return { ...ID, timestamp: ts };
}

async function freshRepo(): Promise<GitRepo> {
	return createStorageAdapter(new MemoryStorage()).createRepo("test");
}

async function makeTree(repo: GitRepo, files: Record<string, string>): Promise<string> {
	const dirs = new Map<string, { name: string; hash: string; mode?: string }[]>();

	for (const [path, content] of Object.entries(files)) {
		const parts = path.split("/");
		const fileName = parts.pop()!;
		const dirKey = parts.length > 0 ? parts.join("/") : "";

		if (!dirs.has(dirKey)) dirs.set(dirKey, []);
		const blob = await writeBlob(repo, content);
		dirs.get(dirKey)!.push({ name: fileName, hash: blob });
	}

	if (dirs.size === 1 && dirs.has("")) {
		return writeTree(repo, dirs.get("")!);
	}

	// Ensure root exists
	if (!dirs.has("")) dirs.set("", []);

	// Build nested trees bottom-up (deepest dirs first)
	const sortedDirs = [...dirs.keys()].sort((a, b) => b.length - a.length);
	const treeHashes = new Map<string, string>();

	for (const dir of sortedDirs) {
		const entries = [...dirs.get(dir)!];

		for (const [childDir, childHash] of treeHashes) {
			const parent = childDir.includes("/") ? childDir.substring(0, childDir.lastIndexOf("/")) : "";
			if (parent === dir) {
				const childName = childDir.includes("/")
					? childDir.substring(childDir.lastIndexOf("/") + 1)
					: childDir;
				entries.push({ name: childName, hash: childHash, mode: "040000" });
			}
		}

		const hash = await writeTree(repo, entries);
		treeHashes.set(dir, hash);
	}

	return treeHashes.get("")!;
}

async function commit(
	repo: GitRepo,
	files: Record<string, string>,
	parents: string[],
	ts = 1000000000,
	opts?: { branch?: string },
): Promise<string> {
	const tree = await makeTree(repo, files);
	return createCommit(repo, {
		tree,
		parents,
		author: idAt(ts),
		committer: idAt(ts),
		message: `commit at ${ts}\n`,
		branch: opts?.branch,
	});
}

// ── diffCommits ─────────────────────────────────────────────────────

describe("diffCommits", () => {
	test("detects added files", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "a.txt": "hello\n" }, [], 1);
		const c2 = await commit(repo, { "a.txt": "hello\n", "b.txt": "world\n" }, [c1], 2);

		const diffs = await diffCommits(repo, c1, c2);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]!.path).toBe("b.txt");
		expect(diffs[0]!.status).toBe("added");
		expect(diffs[0]!.hunks).toHaveLength(1);
		expect(diffs[0]!.hunks[0]!.lines).toContain("+world");
	});

	test("detects deleted files", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "a.txt": "hello\n", "b.txt": "world\n" }, [], 1);
		const c2 = await commit(repo, { "a.txt": "hello\n" }, [c1], 2);

		const diffs = await diffCommits(repo, c1, c2);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]!.path).toBe("b.txt");
		expect(diffs[0]!.status).toBe("deleted");
		expect(diffs[0]!.hunks[0]!.lines).toContain("-world");
	});

	test("detects modified files with correct hunks", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "a.txt": "line1\nline2\nline3\n" }, [], 1);
		const c2 = await commit(repo, { "a.txt": "line1\nchanged\nline3\n" }, [c1], 2);

		const diffs = await diffCommits(repo, c1, c2);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]!.status).toBe("modified");

		const hunk = diffs[0]!.hunks[0]!;
		expect(hunk.lines).toContain("-line2");
		expect(hunk.lines).toContain("+changed");
		expect(hunk.lines).toContain(" line1");
	});

	test("detects renames", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "old.txt": "content\n" }, [], 1);
		const c2 = await commit(repo, { "new.txt": "content\n" }, [c1], 2);

		const diffs = await diffCommits(repo, c1, c2);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]!.status).toBe("renamed");
		expect(diffs[0]!.path).toBe("new.txt");
		expect(diffs[0]!.oldPath).toBe("old.txt");
		expect(diffs[0]!.similarity).toBe(100);
		expect(diffs[0]!.hunks).toHaveLength(0);
	});

	test("renames with content changes have hunks", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "old.txt": "line1\nline2\nline3\nline4\nline5\n" }, [], 1);
		const c2 = await commit(repo, { "new.txt": "line1\nline2\nchanged\nline4\nline5\n" }, [c1], 2);

		const diffs = await diffCommits(repo, c1, c2);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]!.status).toBe("renamed");
		expect(diffs[0]!.hunks.length).toBeGreaterThan(0);
	});

	test("renames disabled returns add+delete instead", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "old.txt": "content\n" }, [], 1);
		const c2 = await commit(repo, { "new.txt": "content\n" }, [c1], 2);

		const diffs = await diffCommits(repo, c1, c2, { renames: false });
		expect(diffs).toHaveLength(2);
		const statuses = diffs.map((d) => d.status).sort();
		expect(statuses).toEqual(["added", "deleted"]);
	});

	test("paths filter limits results", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "src/a.ts": "a\n", "docs/readme.md": "old\n" }, [], 1);
		const c2 = await commit(repo, { "src/a.ts": "changed\n", "docs/readme.md": "new\n" }, [c1], 2);

		const srcOnly = await diffCommits(repo, c1, c2, { paths: ["src/"] });
		expect(srcOnly).toHaveLength(1);
		expect(srcOnly[0]!.path).toBe("src/a.ts");

		const docsOnly = await diffCommits(repo, c1, c2, { paths: ["docs/"] });
		expect(docsOnly).toHaveLength(1);
		expect(docsOnly[0]!.path).toBe("docs/readme.md");
	});

	test("custom context lines", async () => {
		const repo = await freshRepo();
		const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
		const changed = lines.replace("line10", "CHANGED");
		const c1 = await commit(repo, { "f.txt": lines }, [], 1);
		const c2 = await commit(repo, { "f.txt": changed }, [c1], 2);

		const with1 = await diffCommits(repo, c1, c2, { contextLines: 1 });
		const with5 = await diffCommits(repo, c1, c2, { contextLines: 5 });

		const hunk1 = with1[0]!.hunks[0]!;
		const hunk5 = with5[0]!.hunks[0]!;
		expect(hunk1.lines.length).toBeLessThan(hunk5.lines.length);
	});

	test("no changes returns empty array", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "a.txt": "same\n" }, [], 1);
		const c2 = await commit(repo, { "a.txt": "same\n" }, [c1], 2);

		const diffs = await diffCommits(repo, c1, c2);
		expect(diffs).toHaveLength(0);
	});

	test("resolves ref names", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "a.txt": "v1\n" }, [], 1, { branch: "main" });
		const c2 = await commit(repo, { "a.txt": "v2\n" }, [c1], 2, { branch: "main" });

		// Create a feature branch
		await repo.refStore.writeRef("refs/heads/feature", { type: "direct", hash: c2 });

		const diffs = await diffCommits(repo, "main~1", "main");
		expect(diffs).toHaveLength(1);
	});

	test("multiple files changed", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" }, [], 1);
		const c2 = await commit(
			repo,
			{ "a.txt": "changed\n", "b.txt": "b\n", "c.txt": "also changed\n" },
			[c1],
			2,
		);

		const diffs = await diffCommits(repo, c1, c2);
		expect(diffs).toHaveLength(2);
		const paths = diffs.map((d) => d.path).sort();
		expect(paths).toEqual(["a.txt", "c.txt"]);
	});

	test("hunk structure has correct counts", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "f.txt": "a\nb\nc\n" }, [], 1);
		const c2 = await commit(repo, { "f.txt": "a\nB\nc\n" }, [c1], 2);

		const diffs = await diffCommits(repo, c1, c2);
		const hunk = diffs[0]!.hunks[0]!;

		expect(hunk.oldStart).toBeGreaterThan(0);
		expect(hunk.newStart).toBeGreaterThan(0);
		expect(hunk.oldCount).toBeGreaterThan(0);
		expect(hunk.newCount).toBeGreaterThan(0);

		const inserts = hunk.lines.filter((l) => l.startsWith("+")).length;
		const deletes = hunk.lines.filter((l) => l.startsWith("-")).length;
		expect(inserts).toBe(1);
		expect(deletes).toBe(1);
	});

	test("results are sorted by path", async () => {
		const repo = await freshRepo();
		const c1 = await commit(repo, { "z.txt": "z\n", "a.txt": "a\n", "m.txt": "m\n" }, [], 1);
		const c2 = await commit(repo, { "z.txt": "Z\n", "a.txt": "A\n", "m.txt": "M\n" }, [c1], 2);

		const diffs = await diffCommits(repo, c1, c2);
		const paths = diffs.map((d) => d.path);
		expect(paths).toEqual(["a.txt", "m.txt", "z.txt"]);
	});
});
