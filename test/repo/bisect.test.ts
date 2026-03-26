import { describe, expect, test } from "bun:test";
import type { Identity, GitRepo } from "../../src/lib/types.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { bisect, type BisectStepInfo } from "../../src/repo/operations.ts";
import { MemoryFileSystem } from "../../src/memory-fs.ts";

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

/**
 * Build a linear chain of N commits. Each commit has a single file
 * whose content is "commit-{i}". Returns the hashes in order
 * (index 0 = root, index N-1 = tip).
 */
async function buildLinearChain(repo: GitRepo, n: number): Promise<string[]> {
	const hashes: string[] = [];
	for (let i = 0; i < n; i++) {
		const blob = await writeBlob(repo, `commit-${i}\n`);
		const tree = await writeTree(repo, [{ name: "file.txt", hash: blob }]);
		const hash = await createCommit(repo, {
			tree,
			parents: hashes.length > 0 ? [hashes[hashes.length - 1]!] : [],
			author: idAt(1000000000 + i),
			message: `commit ${i}\n`,
		});
		hashes.push(hash);
	}
	return hashes;
}

// ── Happy path ──────────────────────────────────────────────────────

describe("bisect", () => {
	test("finds the first bad commit in a linear chain", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 10);
		const badIndex = 6;

		const result = await bisect(repo, {
			bad: hashes[9]!,
			good: hashes[0]!,
			test: async (hash) => {
				const idx = hashes.indexOf(hash);
				return idx < badIndex;
			},
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(hashes[badIndex]!);
		}
	});

	test("finds bad commit when it is the immediate child of good", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 5);

		const result = await bisect(repo, {
			bad: hashes[4]!,
			good: hashes[3]!,
			test: () => true,
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(hashes[4]!);
		}
	});

	test("finds bad commit at index 1 with good at index 0", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 8);
		const badIndex = 1;

		const result = await bisect(repo, {
			bad: hashes[7]!,
			good: hashes[0]!,
			test: (hash) => {
				const idx = hashes.indexOf(hash);
				return idx < badIndex;
			},
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(hashes[badIndex]!);
		}
	});

	test("works with multiple good commits", async () => {
		const repo = await freshRepo();
		// Build a chain with a branch
		const hashes = await buildLinearChain(repo, 10);
		const badIndex = 7;

		const result = await bisect(repo, {
			bad: hashes[9]!,
			good: [hashes[0]!, hashes[3]!],
			test: (hash) => {
				const idx = hashes.indexOf(hash);
				return idx < badIndex;
			},
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(hashes[badIndex]!);
		}
	});

	// ── Skip handling ───────────────────────────────────────────────

	test("handles skipped commits and still finds the bad one", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 10);
		const badIndex = 5;

		const result = await bisect(repo, {
			bad: hashes[9]!,
			good: hashes[0]!,
			test: (hash) => {
				const idx = hashes.indexOf(hash);
				if (idx === 3 || idx === 7) return "skip";
				return idx < badIndex;
			},
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(hashes[badIndex]!);
		}
	});

	test("returns all-skipped when every candidate is skipped", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 4);

		const result = await bisect(repo, {
			bad: hashes[3]!,
			good: hashes[0]!,
			test: () => "skip",
		});

		expect(result.found).toBe(false);
		if (!result.found && result.reason === "all-skipped") {
			expect(result.candidates.length).toBeGreaterThan(0);
		}
	});

	// ── No testable commits ─────────────────────────────────────────

	test("returns no-testable-commits when good === bad parent", async () => {
		const repo = await freshRepo();
		// Single commit — good and bad are the same
		const blob = await writeBlob(repo, "only\n");
		const tree = await writeTree(repo, [{ name: "f.txt", hash: blob }]);
		const only = await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			message: "only commit\n",
		});

		const result = await bisect(repo, {
			bad: only,
			good: only,
			test: () => true,
		});

		expect(result.found).toBe(false);
		if (!result.found) {
			expect(result.reason).toBe("no-testable-commits");
		}
	});

	// ── onStep callback ─────────────────────────────────────────────

	test("fires onStep with correct progress info", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 8);
		const badIndex = 4;
		const steps: BisectStepInfo[] = [];

		const result = await bisect(repo, {
			bad: hashes[7]!,
			good: hashes[0]!,
			test: (hash) => {
				const idx = hashes.indexOf(hash);
				return idx < badIndex;
			},
			onStep: (info) => steps.push({ ...info }),
		});

		expect(result.found).toBe(true);
		expect(steps.length).toBeGreaterThan(0);

		// Step numbers should be sequential starting from 1
		for (let i = 0; i < steps.length; i++) {
			expect(steps[i]!.stepNumber).toBe(i + 1);
		}

		// Each step should have a valid verdict
		for (const step of steps) {
			expect(["good", "bad", "skip"]).toContain(step.verdict);
			expect(step.hash).toMatch(/^[0-9a-f]{40}$/);
			expect(step.subject.length).toBeGreaterThan(0);
		}
	});

	// ── firstParent option ──────────────────────────────────────────

	test("respects firstParent option", async () => {
		const repo = await freshRepo();
		// Build a main line and a side branch that merges in
		const main = await buildLinearChain(repo, 5);
		const badIndex = 3;

		const result = await bisect(repo, {
			bad: main[4]!,
			good: main[0]!,
			firstParent: true,
			test: (hash) => {
				const idx = main.indexOf(hash);
				return idx < badIndex;
			},
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(main[badIndex]!);
		}
	});

	// ── Async test function ─────────────────────────────────────────

	test("supports async test functions", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 6);
		const badIndex = 3;

		const result = await bisect(repo, {
			bad: hashes[5]!,
			good: hashes[0]!,
			test: async (hash) => {
				await new Promise((r) => setTimeout(r, 1));
				const idx = hashes.indexOf(hash);
				return idx < badIndex;
			},
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(hashes[badIndex]!);
		}
	});

	// ── Rev-parse expressions ───────────────────────────────────────

	test("accepts ref names for bad and good", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 6);
		const badIndex = 3;

		// Write refs so we can use branch names
		await repo.refStore.writeRef("refs/heads/main", {
			type: "direct",
			hash: hashes[5]!,
		});
		await repo.refStore.writeRef("refs/tags/v1.0", {
			type: "direct",
			hash: hashes[0]!,
		});

		const result = await bisect(repo, {
			bad: "main",
			good: "v1.0",
			test: (hash) => {
				const idx = hashes.indexOf(hash);
				return idx < badIndex;
			},
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(hashes[badIndex]!);
		}
	});

	// ── TreeAccessor ────────────────────────────────────────────────

	test("tree.readFile returns file content at the candidate commit", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 6);
		const badIndex = 3;
		const seen = new Map<string, string | null>();

		const result = await bisect(repo, {
			bad: hashes[5]!,
			good: hashes[0]!,
			test: async (hash, tree) => {
				const content = await tree.readFile("file.txt");
				seen.set(hash, content);
				const idx = hashes.indexOf(hash);
				return idx < badIndex;
			},
		});

		expect(result.found).toBe(true);
		// Every tested commit should have had its file content read
		for (const [hash, content] of seen) {
			const idx = hashes.indexOf(hash);
			expect(content).toBe(`commit-${idx}\n`);
		}
	});

	test("tree.readFile returns null for non-existent files", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 4);

		await bisect(repo, {
			bad: hashes[3]!,
			good: hashes[0]!,
			test: async (hash, tree) => {
				const content = await tree.readFile("does-not-exist.txt");
				expect(content).toBeNull();
				return hashes.indexOf(hash) < 2;
			},
		});
	});

	test("tree.readFileBytes returns raw bytes", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 4);

		await bisect(repo, {
			bad: hashes[3]!,
			good: hashes[0]!,
			test: async (hash, tree) => {
				const bytes = await tree.readFileBytes("file.txt");
				expect(bytes).toBeInstanceOf(Uint8Array);
				const idx = hashes.indexOf(hash);
				const text = new TextDecoder().decode(bytes!);
				expect(text).toBe(`commit-${idx}\n`);
				return idx < 2;
			},
		});
	});

	test("tree.files lists all tracked paths", async () => {
		const repo = await freshRepo();
		// Build commits with multiple files
		const hashes: string[] = [];
		for (let i = 0; i < 5; i++) {
			const blobs = await Promise.all([
				writeBlob(repo, `a-${i}\n`),
				writeBlob(repo, `b-${i}\n`),
				writeBlob(repo, `c-${i}\n`),
			]);
			const tree = await writeTree(repo, [
				{ name: "a.txt", hash: blobs[0]! },
				{ name: "b.txt", hash: blobs[1]! },
				{ name: "c.txt", hash: blobs[2]! },
			]);
			const hash = await createCommit(repo, {
				tree,
				parents: hashes.length > 0 ? [hashes[hashes.length - 1]!] : [],
				author: idAt(1000000000 + i),
				message: `commit ${i}\n`,
			});
			hashes.push(hash);
		}

		await bisect(repo, {
			bad: hashes[4]!,
			good: hashes[0]!,
			test: async (hash, tree) => {
				const paths = await tree.files();
				expect(paths.sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
				return hashes.indexOf(hash) < 3;
			},
		});
	});

	test("tree.fs returns a working FileSystem", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 4);

		await bisect(repo, {
			bad: hashes[3]!,
			good: hashes[0]!,
			test: async (hash, tree) => {
				const fs = tree.fs();
				const content = await fs.readFile("file.txt");
				const idx = hashes.indexOf(hash);
				expect(content).toBe(`commit-${idx}\n`);

				// Writes go to overlay, don't affect the repo
				await fs.writeFile("tmp.txt", "hello");
				const tmp = await fs.readFile("tmp.txt");
				expect(tmp).toBe("hello");

				return idx < 2;
			},
		});
	});

	test("tree.fs is cached across calls with same root", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 4);

		await bisect(repo, {
			bad: hashes[3]!,
			good: hashes[0]!,
			test: async (_hash, tree) => {
				const fs1 = tree.fs();
				const fs2 = tree.fs();
				expect(fs1).toBe(fs2);

				const fs3 = tree.fs("/other");
				expect(fs3).not.toBe(fs1);
				return false;
			},
		});
	});

	test("bisect finds bad commit using tree.readFile for content inspection", async () => {
		const repo = await freshRepo();
		const hashes: string[] = [];
		for (let i = 0; i < 8; i++) {
			const content = i >= 4 ? `feature code\nBUG: broken\n` : `feature code\nall good\n`;
			const blob = await writeBlob(repo, content);
			const subtree = await writeTree(repo, [{ name: "main.ts", hash: blob }]);
			const tree = await writeTree(repo, [{ name: "src", hash: subtree, mode: "40000" }]);
			const hash = await createCommit(repo, {
				tree,
				parents: hashes.length > 0 ? [hashes[hashes.length - 1]!] : [],
				author: idAt(1000000000 + i),
				message: `commit ${i}\n`,
			});
			hashes.push(hash);
		}

		const result = await bisect(repo, {
			bad: hashes[7]!,
			good: hashes[0]!,
			test: async (_hash, tree) => {
				const content = await tree.readFile("src/main.ts");
				return content !== null && !content.includes("BUG");
			},
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(hashes[4]!);
		}
	});

	// ── Materialize ─────────────────────────────────────────────────

	test("tree.materialize writes all tracked files to a filesystem", async () => {
		const repo = await freshRepo();
		const hashes: string[] = [];
		for (let i = 0; i < 4; i++) {
			const blobs = await Promise.all([writeBlob(repo, `a-${i}\n`), writeBlob(repo, `b-${i}\n`)]);
			const tree = await writeTree(repo, [
				{ name: "a.txt", hash: blobs[0]! },
				{ name: "b.txt", hash: blobs[1]! },
			]);
			const hash = await createCommit(repo, {
				tree,
				parents: hashes.length > 0 ? [hashes[hashes.length - 1]!] : [],
				author: idAt(1000000000 + i),
				message: `commit ${i}\n`,
			});
			hashes.push(hash);
		}

		await bisect(repo, {
			bad: hashes[3]!,
			good: hashes[0]!,
			test: async (_hash, tree) => {
				const targetFs = new MemoryFileSystem();
				const count = await tree.materialize(targetFs);
				expect(count).toBe(2);

				const a = await targetFs.readFile("/a.txt");
				const b = await targetFs.readFile("/b.txt");
				const idx = hashes.indexOf(_hash);
				expect(a).toBe(`a-${idx}\n`);
				expect(b).toBe(`b-${idx}\n`);
				return idx < 2;
			},
		});
	});

	test("tree.materialize writes to a custom target directory", async () => {
		const repo = await freshRepo();
		const hashes = await buildLinearChain(repo, 4);

		await bisect(repo, {
			bad: hashes[3]!,
			good: hashes[0]!,
			test: async (_hash, tree) => {
				const targetFs = new MemoryFileSystem();
				await tree.materialize(targetFs, "/build");
				const content = await targetFs.readFile("/build/file.txt");
				const idx = hashes.indexOf(_hash);
				expect(content).toBe(`commit-${idx}\n`);
				return idx < 2;
			},
		});
	});

	test("tree.materialize handles nested directories", async () => {
		const repo = await freshRepo();
		const blob = await writeBlob(repo, "nested\n");
		const inner = await writeTree(repo, [{ name: "deep.txt", hash: blob }]);
		const mid = await writeTree(repo, [{ name: "inner", hash: inner, mode: "40000" }]);
		const root = await writeTree(repo, [{ name: "outer", hash: mid, mode: "40000" }]);
		const c1 = await createCommit(repo, {
			tree: root,
			parents: [],
			author: ID,
			message: "nested\n",
		});
		const blob2 = await writeBlob(repo, "nested-bad\n");
		const inner2 = await writeTree(repo, [{ name: "deep.txt", hash: blob2 }]);
		const mid2 = await writeTree(repo, [{ name: "inner", hash: inner2, mode: "40000" }]);
		const root2 = await writeTree(repo, [{ name: "outer", hash: mid2, mode: "40000" }]);
		const c2 = await createCommit(repo, {
			tree: root2,
			parents: [c1],
			author: idAt(1000000001),
			message: "nested bad\n",
		});

		const result = await bisect(repo, {
			bad: c2,
			good: c1,
			test: async (_hash, tree) => {
				const targetFs = new MemoryFileSystem();
				await tree.materialize(targetFs);
				const content = await targetFs.readFile("/outer/inner/deep.txt");
				return !content.includes("bad");
			},
		});

		expect(result.found).toBe(true);
		if (result.found) {
			expect(result.hash).toBe(c2);
		}
	});
});
