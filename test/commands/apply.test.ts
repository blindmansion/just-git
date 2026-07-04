import { describe, expect, test } from "bun:test";
import type { Bash } from "just-bash";
import { EMPTY_REPO, TEST_ENV } from "../fixtures";
import { createTestBash, readFile } from "../util";

// ── Setup helpers ────────────────────────────────────────────────────

/** A committed repo seeded with `files` (paths relative to /repo). */
async function repoWith(files: Record<string, string>): Promise<Bash> {
	const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
	await bash.exec("git init");
	for (const [p, content] of Object.entries(files)) {
		await bash.fs.writeFile(`/repo/${p}`, content);
	}
	await bash.exec("git add .");
	await bash.exec('git commit -m "base"');
	return bash;
}

/** `git apply` reading the patch from stdin. */
function apply(bash: Bash, patch: string, flags = "") {
	return bash.exec(`git apply ${flags}`.trim(), { stdin: patch });
}

// The canonical modify patch: line1/line2/line3 → line1/changed/line3/line4.
// (Byte-identical to the diff `format-patch` emits for this content, so the
// `index` line's base OID resolves for `-3`.)
const THREE_LINES = "line1\nline2\nline3\n";
const MODIFY_PATCH = `diff --git a/file.txt b/file.txt
index 83db48f..d76b0c2 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line1
-line2
+changed
 line3
+line4
`;
const MODIFIED = "line1\nchanged\nline3\nline4\n";

describe("git apply", () => {
	describe("error cases", () => {
		test("outside a git repo", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			const result = await apply(bash, MODIFY_PATCH);
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("a missing patch file is fatal", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await bash.exec("git apply nope.patch");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("can't open patch 'nope.patch'");
		});

		test("empty input is rejected", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, "\n\n");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("unrecognized input");
		});

		test("a hunk that does not match reports patch failed", async () => {
			const bash = await repoWith({ "file.txt": "totally\ndifferent\ncontent\n" });
			const result = await apply(bash, MODIFY_PATCH);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("error: patch failed: file.txt:1");
			expect(result.stderr).toContain("error: file.txt: patch does not apply");
			// All-or-nothing: the worktree is untouched.
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe("totally\ndifferent\ncontent\n");
		});
	});

	describe("modify", () => {
		test("applies a text hunk to the worktree", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, MODIFY_PATCH);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe(MODIFIED);
		});

		test("-R reverses the patch", async () => {
			const bash = await repoWith({ "file.txt": MODIFIED });
			const result = await apply(bash, MODIFY_PATCH, "-R");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe(THREE_LINES);
		});

		test("default apply leaves the index untouched", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			await apply(bash, MODIFY_PATCH);
			const status = await bash.exec("git status --porcelain");
			// Worktree modified, nothing staged.
			expect(status.stdout).toBe(" M file.txt\n");
		});
	});

	describe("create and delete", () => {
		const CREATE_PATCH = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..180cf83
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

		test("creates a new file", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, CREATE_PATCH);
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/new.txt")).toBe("hello\nworld\n");
		});

		test("deletes a file", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const DELETE_PATCH = `diff --git a/file.txt b/file.txt
deleted file mode 100644
index 83db48f..0000000 100644
--- a/file.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
`;
			const result = await apply(bash, DELETE_PATCH);
			expect(result.exitCode).toBe(0);
			expect(await bash.fs.exists("/repo/file.txt")).toBe(false);
		});
	});

	describe("rename", () => {
		test("moves a file at 100% similarity", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const RENAME_PATCH = `diff --git a/file.txt b/renamed.txt
similarity index 100%
rename from file.txt
rename to renamed.txt
`;
			const result = await apply(bash, RENAME_PATCH);
			expect(result.exitCode).toBe(0);
			expect(await bash.fs.exists("/repo/file.txt")).toBe(false);
			expect(await readFile(bash.fs, "/repo/renamed.txt")).toBe(THREE_LINES);
		});
	});

	describe("--check", () => {
		test("reports success without writing", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, MODIFY_PATCH, "--check");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe(THREE_LINES);
		});

		test("fails on a patch that would not apply", async () => {
			const bash = await repoWith({ "file.txt": "nope\n" });
			const result = await apply(bash, MODIFY_PATCH, "--check");
			expect(result.exitCode).toBe(1);
		});
	});

	describe("info-only modes", () => {
		test("--stat summarizes the change", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, MODIFY_PATCH, "--stat");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(" file.txt | 3 ++-");
			expect(result.stdout).toContain("1 file changed, 2 insertions(+), 1 deletion(-)");
		});

		test("--numstat is machine friendly", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, MODIFY_PATCH, "--numstat");
			expect(result.stdout).toBe("2\t1\tfile.txt\n");
		});

		test("--summary shows extended headers only", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const CREATE_PATCH = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..180cf83
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hi
`;
			const result = await apply(bash, CREATE_PATCH, "--summary");
			expect(result.stdout).toBe(" create mode 100644 new.txt\n");
		});
	});

	describe("--index / --cached", () => {
		test("--cached stages the change without touching the worktree", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, MODIFY_PATCH, "--cached");
			expect(result.exitCode).toBe(0);
			// Worktree unchanged, index updated — so the worktree now differs
			// from the freshly-staged index too (git reports "MM").
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe(THREE_LINES);
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toBe("MM file.txt\n");
		});

		test("--index updates both the index and the worktree", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, MODIFY_PATCH, "--index");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe(MODIFIED);
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toBe("M  file.txt\n");
		});
	});

	describe("--reject", () => {
		test("applies the good hunk and drops the bad one into .rej", async () => {
			const bash = await repoWith({ "file.txt": "a\nb\nc\nd\ne\nf\ng\nh\n" });
			const TWO_HUNK = `diff --git a/file.txt b/file.txt
index 1111111..2222222 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -6,3 +6,3 @@
 XX
-g
+G
 h
`;
			const result = await apply(bash, TWO_HUNK, "--reject");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Rejected hunk #2");
			// First hunk applied.
			expect(await readFile(bash.fs, "/repo/file.txt")).toContain("B\n");
			// Rejected hunk lands in file.txt.rej.
			const rej = await readFile(bash.fs, "/repo/file.txt.rej");
			expect(rej).toContain("@@ -6,3 +6,3 @@");
		});
	});

	describe("whitespace", () => {
		const WS_PATCH = `diff --git a/file.txt b/file.txt
index 83db48f..3333333 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line1
 line2
 line3
+trailing   
`;

		test("default warns but still applies", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, WS_PATCH);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("trailing whitespace");
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe("line1\nline2\nline3\ntrailing   \n");
		});

		test("--whitespace=error refuses to apply", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, WS_PATCH, "--whitespace=error");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("whitespace error");
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe(THREE_LINES);
		});
	});

	describe("--include / --exclude", () => {
		const TWO_FILE_PATCH = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-a
+A
diff --git a/b.txt b/b.txt
index 3333333..4444444 100644
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-b
+B
`;

		test("--include applies only the matching file", async () => {
			const bash = await repoWith({ "a.txt": "a\n", "b.txt": "b\n" });
			const result = await apply(bash, TWO_FILE_PATCH, "--include=a.txt");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/a.txt")).toBe("A\n");
			expect(await readFile(bash.fs, "/repo/b.txt")).toBe("b\n");
		});

		test("--exclude skips the matching file", async () => {
			const bash = await repoWith({ "a.txt": "a\n", "b.txt": "b\n" });
			const result = await apply(bash, TWO_FILE_PATCH, "--exclude=a.txt");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/a.txt")).toBe("a\n");
			expect(await readFile(bash.fs, "/repo/b.txt")).toBe("B\n");
		});
	});

	describe("-p / --strip", () => {
		test("-p0 keeps the full path", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const P0_PATCH = `diff --git file.txt file.txt
index 83db48f..d76b0c2 100644
--- file.txt
+++ file.txt
@@ -1,3 +1,4 @@
 line1
-line2
+changed
 line3
+line4
`;
			const result = await apply(bash, P0_PATCH, "-p0");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe(MODIFIED);
		});
	});

	describe("--directory", () => {
		test("prepends the root to every path", async () => {
			const bash = await repoWith({ "sub/file.txt": THREE_LINES });
			const result = await apply(bash, MODIFY_PATCH, "--directory=sub");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/sub/file.txt")).toBe(MODIFIED);
		});
	});

	describe("-3 / --3way", () => {
		// "theirs" touches line3 only; base OID (83db48f) still resolves.
		const MODIFY_LINE3 = `diff --git a/file.txt b/file.txt
index 83db48f..aaaaaaa 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
 line2
-line3
+CHANGED
`;

		test("cleanly merges a divergent worktree", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			// "ours" changes line1; "theirs" changes line3 — line2 keeps them
			// apart so the 3-way merge is clean. (`-3` implies --index.)
			await bash.fs.writeFile("/repo/file.txt", "LINE1\nline2\nline3\n");
			await bash.exec("git add file.txt");
			const result = await apply(bash, MODIFY_LINE3, "--3way");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Applied patch to 'file.txt' cleanly.");
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe("LINE1\nline2\nCHANGED\n");
		});

		test("records conflict markers when both sides touch the same line", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			await bash.fs.writeFile("/repo/file.txt", "line1\nOURS\nline3\n");
			await bash.exec("git add file.txt");
			const result = await apply(bash, MODIFY_PATCH, "--3way");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Applied patch to 'file.txt' with conflicts.");
			const content = await readFile(bash.fs, "/repo/file.txt");
			expect(content).toContain("<<<<<<<");
			expect(content).toContain(">>>>>>>");
		});

		test("cannot be combined with --reject", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, MODIFY_PATCH, "--3way --reject");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("cannot be used together");
		});
	});
});
