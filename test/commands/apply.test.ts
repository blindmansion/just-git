import { describe, expect, test } from "bun:test";
import type { Bash } from "just-bash";
import { formatBinaryPatch } from "../../src/lib/diff/binary-patch.ts";
import { hashObject } from "../../src/lib/object-db.ts";
import { EMPTY_REPO, TEST_ENV } from "../fixtures";
import { createTestBash, readFile } from "../util";

// ── Setup helpers ────────────────────────────────────────────────────

/** A committed repo seeded with `files` (paths relative to /repo). */
async function repoWith(files: Record<string, string | Uint8Array>): Promise<Bash> {
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
const BINARY_PREIMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
const BINARY_POSTIMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x80, 0x81, 0x02]);

async function binaryModifyPatch(): Promise<string> {
	const oldOid = await hashObject("blob", BINARY_PREIMAGE);
	const newOid = await hashObject("blob", BINARY_POSTIMAGE);
	const body = await formatBinaryPatch(BINARY_PREIMAGE, BINARY_POSTIMAGE);
	return `diff --git a/file.bin b/file.bin
index ${oldOid}..${newOid} 100644
${body}`;
}

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

		test("--index rejects a worktree that disagrees with the index", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			// Diverge the worktree from the (committed) index without staging.
			await bash.fs.writeFile("/repo/file.txt", "line1\nlocal-edit\nline3\n");
			const result = await apply(bash, MODIFY_PATCH, "--index");
			// git's check_preimage fails before the hunks are ever tried.
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("error: file.txt: does not match index");
			expect(result.stderr).not.toContain("patch failed");
		});

		test("--index checks out a missing worktree file from the index", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			// Delete the worktree copy but leave the index entry intact.
			await bash.fs.rm("/repo/file.txt", { force: true });
			const result = await apply(bash, MODIFY_PATCH, "--index");
			// checkout_target restores the index content, then the patch applies.
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe(MODIFIED);
		});

		test("--index restores a checked-out file even when the apply fails", async () => {
			const bash = await repoWith({
				"file.txt": THREE_LINES,
				"other.txt": "keep\n",
			});
			// file.txt is missing from the worktree (but tracked); other.txt is
			// present but mismatched, which makes the batch fail.
			await bash.fs.rm("/repo/file.txt", { force: true });
			await bash.fs.writeFile("/repo/other.txt", "unexpected\n");
			const TWO_FILE = `${MODIFY_PATCH}diff --git a/other.txt b/other.txt
index 1111111..2222222 100644
--- a/other.txt
+++ b/other.txt
@@ -1 +1 @@
-keep
+kept
`;
			const result = await apply(bash, TWO_FILE, "--index");
			expect(result.exitCode).toBe(1);
			// The whole apply is rejected (all-or-nothing) …
			expect(result.stderr).toContain("error: other.txt: does not match index");
			// … but git's checkout_target side effect still restored file.txt.
			expect(await readFile(bash.fs, "/repo/file.txt")).toBe(THREE_LINES);
		});

		test("--index applies a binary modification to the index and worktree", async () => {
			const bash = await repoWith({ "file.bin": BINARY_PREIMAGE });
			const result = await apply(bash, await binaryModifyPatch(), "--index");

			expect(result.exitCode).toBe(0);
			expect(await bash.fs.readFileBuffer("/repo/file.bin")).toEqual(BINARY_POSTIMAGE);
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toBe("M  file.bin\n");
		});

		test("--index applies a binary patch when the worktree file is missing", async () => {
			const bash = await repoWith({ "file.bin": BINARY_PREIMAGE });
			await bash.fs.rm("/repo/file.bin", { force: true });

			const result = await apply(bash, await binaryModifyPatch(), "--index");

			expect(result.exitCode).toBe(0);
			expect(await bash.fs.readFileBuffer("/repo/file.bin")).toEqual(BINARY_POSTIMAGE);
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toBe("M  file.bin\n");
		});

		test("--index rejects binary worktree bytes that disagree with the index", async () => {
			const bash = await repoWith({ "file.bin": BINARY_PREIMAGE });
			const dirty = new Uint8Array([0x00, 0xde, 0xad, 0xbe, 0xef, 0xff]);
			await bash.fs.writeFile("/repo/file.bin", dirty);

			const result = await apply(bash, await binaryModifyPatch(), "--index");

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("error: file.bin: does not match index");
			expect(result.stderr).not.toContain("the patch applies to");
			expect(await bash.fs.readFileBuffer("/repo/file.bin")).toEqual(dirty);
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toBe(" M file.bin\n");
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
		const ADD_PATCH = `diff --git a/add.txt b/add.txt
new file mode 100644
index 0000000..1275430
--- /dev/null
+++ b/add.txt
@@ -0,0 +1 @@
+same
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

		test("cleanly resolves add-add when both sides added the same content", async () => {
			const bash = await repoWith({ "base.txt": "base\n" });
			await bash.fs.writeFile("/repo/add.txt", "same\n");
			await bash.exec("git add add.txt");

			const result = await apply(bash, ADD_PATCH, "--3way");

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe(
				"Performing three-way merge...\nApplied patch to 'add.txt' cleanly.\n",
			);
			expect(await readFile(bash.fs, "/repo/add.txt")).toBe("same\n");
			const oid = await hashObject("blob", new TextEncoder().encode("same\n"));
			const stages = await bash.exec("git ls-files --stage add.txt");
			expect(stages.stdout).toBe(`100644 ${oid} 0\tadd.txt\n`);
		});

		test("records only stages 2 and 3 for an add-add conflict", async () => {
			const bash = await repoWith({ "base.txt": "base\n" });
			await bash.fs.writeFile("/repo/add.txt", "ours\n");
			await bash.exec("git add add.txt");

			const result = await apply(bash, ADD_PATCH, "--3way");

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe(
				"Performing three-way merge...\nApplied patch to 'add.txt' with conflicts.\nU add.txt\n",
			);
			expect(await readFile(bash.fs, "/repo/add.txt")).toBe(
				"<<<<<<< ours\nours\n=======\nsame\n>>>>>>> theirs\n",
			);
			const oursOid = await hashObject("blob", new TextEncoder().encode("ours\n"));
			const theirsOid = await hashObject("blob", new TextEncoder().encode("same\n"));
			const stages = await bash.exec("git ls-files --stage add.txt");
			expect(stages.stdout).toBe(`100644 ${oursOid} 2\tadd.txt\n100644 ${theirsOid} 3\tadd.txt\n`);
		});

		test("keeps ours and records all stages for a binary conflict", async () => {
			const ours = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x70, 0x71, 0x03]);
			const bash = await repoWith({ "file.bin": BINARY_PREIMAGE });
			await bash.fs.writeFile("/repo/file.bin", ours);
			await bash.exec("git add file.bin");

			const result = await apply(bash, await binaryModifyPatch(), "--3way");

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe(
				"warning: Cannot merge binary files: file.bin (ours vs. theirs)\n" +
					"Applied patch to 'file.bin' with conflicts.\n" +
					"U file.bin\n",
			);
			expect(await bash.fs.readFileBuffer("/repo/file.bin")).toEqual(ours);

			const baseOid = await hashObject("blob", BINARY_PREIMAGE);
			const oursOid = await hashObject("blob", ours);
			const theirsOid = await hashObject("blob", BINARY_POSTIMAGE);
			const stages = await bash.exec("git ls-files --stage file.bin");
			expect(stages.stdout).toBe(
				`100644 ${baseOid} 1\tfile.bin\n` +
					`100644 ${oursOid} 2\tfile.bin\n` +
					`100644 ${theirsOid} 3\tfile.bin\n`,
			);
		});

		test("cannot be combined with --reject", async () => {
			const bash = await repoWith({ "file.txt": THREE_LINES });
			const result = await apply(bash, MODIFY_PATCH, "--3way --reject");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("cannot be used together");
		});
	});
});
