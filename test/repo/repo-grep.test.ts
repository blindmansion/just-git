import { describe, expect, test } from "bun:test";
import type { Identity, GitRepo } from "../../src/lib/types.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createCommit, grep, writeBlob, writeTree } from "../../src/repo/helpers.ts";

const ID: Identity = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function freshRepo(): GitRepo {
	const s = new MemoryStorage();
	return s.createRepo("test");
}

async function commitFiles(
	repo: GitRepo,
	files: Record<string, string>,
	parents: string[] = [],
): Promise<string> {
	const entries = await Promise.all(
		Object.entries(files).map(async ([name, content]) => ({
			name,
			hash: await writeBlob(repo, content),
		})),
	);
	const tree = await writeTree(repo, entries);
	return createCommit(repo, {
		tree,
		parents,
		author: ID,
		committer: ID,
		message: "commit\n",
	});
}

async function commitTree(
	repo: GitRepo,
	structure: Record<string, string>,
	parents: string[] = [],
): Promise<string> {
	const dirs = new Map<string, { name: string; hash: string }[]>();
	const rootEntries: { name: string; hash: string }[] = [];

	for (const [path, content] of Object.entries(structure)) {
		const blobHash = await writeBlob(repo, content);
		const slashIdx = path.indexOf("/");
		if (slashIdx === -1) {
			rootEntries.push({ name: path, hash: blobHash });
		} else {
			const dir = path.slice(0, slashIdx);
			const rest = path.slice(slashIdx + 1);
			if (!dirs.has(dir)) dirs.set(dir, []);
			dirs.get(dir)!.push({ name: rest, hash: blobHash });
		}
	}

	for (const [dir, entries] of dirs) {
		const subtree = await writeTree(repo, entries);
		rootEntries.push({ name: dir, hash: subtree });
	}

	const tree = await writeTree(repo, rootEntries);
	return createCommit(repo, {
		tree,
		parents,
		author: ID,
		committer: ID,
		message: "commit\n",
	});
}

// ── Basic matching ──────────────────────────────────────────────────

describe("grep", () => {
	test("finds matching lines in a single file", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"hello.txt": "hello world\ngoodbye world\nhello again\n",
		});

		const results = await grep(repo, hash, ["hello"]);
		expect(results).toHaveLength(1);
		expect(results[0]!.path).toBe("hello.txt");
		expect(results[0]!.matches).toHaveLength(2);
		expect(results[0]!.matches[0]).toEqual({ lineNo: 1, line: "hello world" });
		expect(results[0]!.matches[1]).toEqual({ lineNo: 3, line: "hello again" });
	});

	test("returns empty array when nothing matches", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, { "file.txt": "no match here\n" });

		const results = await grep(repo, hash, ["zzz"]);
		expect(results).toEqual([]);
	});

	test("searches multiple files", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"a.txt": "TODO fix this\n",
			"b.txt": "all good\n",
			"c.txt": "another TODO\n",
		});

		const results = await grep(repo, hash, ["TODO"]);
		expect(results).toHaveLength(2);
		const paths = results.map((r) => r.path).sort();
		expect(paths).toEqual(["a.txt", "c.txt"]);
	});

	test("results are sorted by path", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"z.txt": "match\n",
			"a.txt": "match\n",
			"m.txt": "match\n",
		});

		const results = await grep(repo, hash, ["match"]);
		expect(results.map((r) => r.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
	});

	// ── Regex patterns ──────────────────────────────────────────────

	test("supports regex patterns as strings", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"file.txt": "foo123\nbar456\nfoo789\n",
		});

		const results = await grep(repo, hash, ["foo\\d+"]);
		expect(results).toHaveLength(1);
		expect(results[0]!.matches).toHaveLength(2);
	});

	test("supports RegExp objects directly", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"file.txt": "Hello World\nhello world\n",
		});

		const results = await grep(repo, hash, [/hello/i]);
		expect(results[0]!.matches).toHaveLength(2);
	});

	test("throws on invalid regex string", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, { "file.txt": "content\n" });

		expect(grep(repo, hash, ["[invalid"])).rejects.toThrow("Invalid pattern");
	});

	// ── Options ─────────────────────────────────────────────────────

	test("fixed strings escapes regex metacharacters", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"file.txt": "price is $10.00\nprice is X10Y00\n",
		});

		const results = await grep(repo, hash, ["$10.00"], { fixed: true });
		expect(results[0]!.matches).toHaveLength(1);
		expect(results[0]!.matches[0]!.line).toBe("price is $10.00");
	});

	test("ignoreCase", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"file.txt": "Hello\nhello\nHELLO\n",
		});

		const sensitive = await grep(repo, hash, ["hello"]);
		expect(sensitive[0]!.matches).toHaveLength(1);

		const insensitive = await grep(repo, hash, ["hello"], { ignoreCase: true });
		expect(insensitive[0]!.matches).toHaveLength(3);
	});

	test("wordRegexp matches whole words only", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"file.txt": "cat\nconcatenate\nthe cat sat\n",
		});

		const results = await grep(repo, hash, ["cat"], { wordRegexp: true });
		expect(results[0]!.matches).toHaveLength(2);
		expect(results[0]!.matches[0]!.line).toBe("cat");
		expect(results[0]!.matches[1]!.line).toBe("the cat sat");
	});

	test("invert returns non-matching lines", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"file.txt": "keep\nremove\nkeep\n",
		});

		const results = await grep(repo, hash, ["remove"], { invert: true });
		expect(results[0]!.matches).toHaveLength(2);
		expect(results[0]!.matches.every((m) => m.line === "keep")).toBe(true);
	});

	test("maxCount limits matches per file", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"file.txt": "match\nmatch\nmatch\nmatch\nmatch\n",
		});

		const results = await grep(repo, hash, ["match"], { maxCount: 2 });
		expect(results[0]!.matches).toHaveLength(2);
		expect(results[0]!.matches[0]!.lineNo).toBe(1);
		expect(results[0]!.matches[1]!.lineNo).toBe(2);
	});

	// ── Multi-pattern ───────────────────────────────────────────────

	test("multiple patterns use OR by default", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"file.txt": "alpha\nbeta\ngamma\n",
		});

		const results = await grep(repo, hash, ["alpha", "gamma"]);
		expect(results[0]!.matches).toHaveLength(2);
	});

	test("allMatch requires all patterns to hit the file", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"both.txt": "alpha line\nbeta line\n",
			"one.txt": "alpha only\n",
		});

		const results = await grep(repo, hash, ["alpha", "beta"], { allMatch: true });
		expect(results).toHaveLength(1);
		expect(results[0]!.path).toBe("both.txt");
	});

	// ── Path filtering ──────────────────────────────────────────────

	test("paths option filters by glob", async () => {
		const repo = freshRepo();
		const hash = await commitTree(repo, {
			"src/app.ts": "TODO: refactor\n",
			"src/util.ts": "TODO: cleanup\n",
			"README.md": "TODO: write docs\n",
		});

		const results = await grep(repo, hash, ["TODO"], { paths: ["src/*.ts"] });
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.path.startsWith("src/"))).toBe(true);
	});

	test("paths with ** glob", async () => {
		const repo = freshRepo();
		const hash = await commitTree(repo, {
			"src/app.ts": "match\n",
			"src/util.js": "match\n",
			"docs/guide.md": "match\n",
		});

		const results = await grep(repo, hash, ["match"], { paths: ["**/*.ts"] });
		expect(results).toHaveLength(1);
		expect(results[0]!.path).toBe("src/app.ts");
	});

	// ── maxDepth ────────────────────────────────────────────────────

	test("maxDepth limits directory depth", async () => {
		const repo = freshRepo();
		const hash = await commitTree(repo, {
			"root.txt": "match\n",
			"src/shallow.txt": "match\n",
			"src/deep.txt": "match\n",
		});

		const results = await grep(repo, hash, ["match"], { maxDepth: 0 });
		expect(results).toHaveLength(1);
		expect(results[0]!.path).toBe("root.txt");
	});

	test("maxDepth 1 includes one level of nesting", async () => {
		const repo = freshRepo();
		const hash = await commitTree(repo, {
			"root.txt": "match\n",
			"src/file.txt": "match\n",
		});

		const results = await grep(repo, hash, ["match"], { maxDepth: 1 });
		expect(results).toHaveLength(2);
	});

	// ── Edge cases ──────────────────────────────────────────────────

	test("handles empty files", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, { "empty.txt": "" });

		const results = await grep(repo, hash, ["anything"]);
		expect(results).toEqual([]);
	});

	test("handles files without trailing newline", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, { "file.txt": "line one\nline two" });

		const results = await grep(repo, hash, ["two"]);
		expect(results[0]!.matches).toHaveLength(1);
		expect(results[0]!.matches[0]!.lineNo).toBe(2);
	});

	test("line numbers are 1-based", async () => {
		const repo = freshRepo();
		const hash = await commitFiles(repo, {
			"file.txt": "first\nsecond\nthird\n",
		});

		const results = await grep(repo, hash, ["second"]);
		expect(results[0]!.matches[0]!.lineNo).toBe(2);
	});

	test("works with multiple commits (searches the specified one)", async () => {
		const repo = freshRepo();
		const c1 = await commitFiles(repo, { "file.txt": "old content\n" });
		const c2 = await commitFiles(repo, { "file.txt": "new content\n" }, [c1]);

		const r1 = await grep(repo, c1, ["old"]);
		expect(r1).toHaveLength(1);

		const r2 = await grep(repo, c2, ["old"]);
		expect(r2).toHaveLength(0);

		const r3 = await grep(repo, c2, ["new"]);
		expect(r3).toHaveLength(1);
	});

	test("skips symlink entries (mode 120000)", async () => {
		const repo = freshRepo();
		const blobHash = await writeBlob(repo, "match this\n");
		const linkTarget = await writeBlob(repo, "some/target");
		const tree = await writeTree(repo, [
			{ name: "real.txt", hash: blobHash },
			{ name: "link.txt", hash: linkTarget, mode: "120000" },
		]);
		const hash = await createCommit(repo, {
			tree,
			parents: [],
			author: ID,
			committer: ID,
			message: "commit\n",
		});

		const results = await grep(repo, hash, ["match"]);
		expect(results).toHaveLength(1);
		expect(results[0]!.path).toBe("real.txt");
	});
});
