import { describe, expect, test } from "bun:test";
import { GIT_EMULATED_VERSION } from "../../src/lib/version.ts";
import { EMPTY_REPO, TEST_ENV } from "../fixtures";
import { createTestBash, readFile } from "../util";
import type { Bash } from "just-bash";

const SIG = `-- \n${GIT_EMULATED_VERSION}\n`;

/** Two commits: a root that adds file.txt (with a body) and a modify. */
async function setupTwoCommits(): Promise<Bash> {
	const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
	await bash.exec("git init");
	await bash.fs.writeFile("/repo/file.txt", "line1\nline2\nline3\n");
	await bash.exec("git add file.txt");
	await bash.exec('git commit -m "Add file.txt" -m "This is the body."');
	await bash.fs.writeFile("/repo/file.txt", "line1\nchanged\nline3\nline4\n");
	await bash.exec("git add file.txt");
	await bash.exec('git commit -m "Modify file.txt"');
	return bash;
}

describe("git format-patch", () => {
	describe("error cases", () => {
		test("outside a git repo", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			const result = await bash.exec("git format-patch -1 --stdout");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("no range and no count errors", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/f", "x\n");
			await bash.exec("git add f");
			await bash.exec('git commit -m "c1"');
			const result = await bash.exec("git format-patch --stdout");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("Which commits");
		});
	});

	describe("stdout mbox output", () => {
		test("single patch", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -1 --stdout");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(
				`From 8441ef6d1ca35bc28a19dce82ab15db32576dd4f Mon Sep 17 00:00:00 2001
From: Test <test@test.com>
Date: Sun, 9 Sep 2001 01:46:40 +0000
Subject: [PATCH] Modify file.txt

---
 file.txt | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)

diff --git a/file.txt b/file.txt
index 83db48f..d76b0c2 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line1
-line2
+changed
 line3
+line4
${SIG}\n`,
			);
		});

		test("multiple patches are numbered and carry the body", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -2 --stdout");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(
				`From 5ea59c4ecda23b8aa866a4f1162366aa46bd65ac Mon Sep 17 00:00:00 2001
From: Test <test@test.com>
Date: Sun, 9 Sep 2001 01:46:40 +0000
Subject: [PATCH 1/2] Add file.txt

This is the body.
---
 file.txt | 3 +++
 1 file changed, 3 insertions(+)
 create mode 100644 file.txt

diff --git a/file.txt b/file.txt
new file mode 100644
index 0000000..83db48f
--- /dev/null
+++ b/file.txt
@@ -0,0 +1,3 @@
+line1
+line2
+line3
${SIG}\n\n` +
					`From 8441ef6d1ca35bc28a19dce82ab15db32576dd4f Mon Sep 17 00:00:00 2001
From: Test <test@test.com>
Date: Sun, 9 Sep 2001 01:46:40 +0000
Subject: [PATCH 2/2] Modify file.txt

---
 file.txt | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)

diff --git a/file.txt b/file.txt
index 83db48f..d76b0c2 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line1
-line2
+changed
 line3
+line4
${SIG}\n`,
			);
		});

		test("root commit diffs against the empty tree", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -2 --stdout");
			expect(result.stdout).toContain("new file mode 100644");
			expect(result.stdout).toContain("--- /dev/null");
		});
	});

	describe("numbering flags", () => {
		test("-N suppresses numbers even for a series", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -2 -N --stdout");
			const subjects = result.stdout.match(/^Subject:.*/gm);
			expect(subjects).toEqual([
				"Subject: [PATCH] Add file.txt",
				"Subject: [PATCH] Modify file.txt",
			]);
		});

		test("-n forces numbers for a single patch", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -1 -n --stdout");
			expect(result.stdout).toContain("Subject: [PATCH 1/1] Modify file.txt");
		});
	});

	describe("subject prefix", () => {
		test("--rfc uses [RFC PATCH]", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -1 --rfc --stdout");
			expect(result.stdout).toContain("Subject: [RFC PATCH] Modify file.txt");
		});

		test("-v marks a reroll", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -2 -v3 --stdout");
			const subjects = result.stdout.match(/^Subject:.*/gm);
			expect(subjects).toEqual([
				"Subject: [PATCH v3 1/2] Add file.txt",
				"Subject: [PATCH v3 2/2] Modify file.txt",
			]);
		});

		test("--subject-prefix replaces PATCH", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec('git format-patch -2 --subject-prefix="FOO" --stdout');
			expect(result.stdout).toContain("Subject: [FOO 1/2] Add file.txt");
		});
	});

	describe("signoff", () => {
		test("appends a Signed-off-by trailer using the committer", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -1 --signoff --stdout");
			expect(result.stdout).toContain(
				"Subject: [PATCH] Modify file.txt\n\nSigned-off-by: Test <test@test.com>\n---\n",
			);
		});

		test("separates the trailer from an existing body with a blank line", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -1 HEAD~1 --signoff --stdout");
			expect(result.stdout).toContain(
				"This is the body.\n\nSigned-off-by: Test <test@test.com>\n---\n",
			);
		});
	});

	describe("file output", () => {
		test("writes numbered files to cwd and prints their names", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -2");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("0001-Add-file.txt.patch\n0002-Modify-file.txt.patch\n");

			const f1 = await readFile(bash.fs, "/repo/0001-Add-file.txt.patch");
			expect(f1).toContain("Subject: [PATCH 1/2] Add file.txt");
			expect(f1?.endsWith(`${SIG}\n`)).toBe(true);
		});

		test("-o writes to a directory and prefixes the printed names", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -2 -o out/patches");
			expect(result.stdout).toBe(
				"out/patches/0001-Add-file.txt.patch\nout/patches/0002-Modify-file.txt.patch\n",
			);
			expect(await readFile(bash.fs, "/repo/out/patches/0002-Modify-file.txt.patch")).toContain(
				"Subject: [PATCH 2/2] Modify file.txt",
			);
		});

		test("--numbered-files names files by number only", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -2 --numbered-files -o nf");
			expect(result.stdout).toBe("nf/1\nnf/2\n");
			expect(await readFile(bash.fs, "/repo/nf/1")).toContain("Subject: [PATCH 1/2]");
		});

		test("reroll count prefixes file names", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch -2 -v3 -o out");
			expect(result.stdout).toBe(
				"out/v3-0001-Add-file.txt.patch\nout/v3-0002-Modify-file.txt.patch\n",
			);
		});
	});

	describe("revision selection", () => {
		test("<rev> is shorthand for <rev>..HEAD", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch HEAD~1 --stdout");
			const subjects = result.stdout.match(/^Subject:.*/gm);
			expect(subjects).toEqual(["Subject: [PATCH] Modify file.txt"]);
		});

		test("<since>..<until> range", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch HEAD~1..HEAD --stdout");
			const subjects = result.stdout.match(/^Subject:.*/gm);
			expect(subjects).toEqual(["Subject: [PATCH] Modify file.txt"]);
		});
	});

	describe("cover letter", () => {
		test("emits a [PATCH 0/N] cover with a shortlog", async () => {
			const bash = await setupTwoCommits();
			const result = await bash.exec("git format-patch --cover-letter -2 --stdout");
			expect(result.stdout).toContain("Subject: [PATCH 0/2] *** SUBJECT HERE ***");
			expect(result.stdout).toContain("*** BLURB HERE ***");
			expect(result.stdout).toContain("Test (2):\n  Add file.txt\n  Modify file.txt\n");
			// Cover letter is separated from the first patch by a single blank line.
			expect(result.stdout).toContain(`${SIG}\nFrom `);
		});
	});

	describe("mode changes", () => {
		/** Commit s.sh, then chmod +x and commit the pure mode change. */
		async function setupModeChange(): Promise<Bash> {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/s.sh", "echo hi\n");
			await bash.exec("git add s.sh");
			await bash.exec('git commit -m "Add s.sh"');
			await bash.exec("chmod +x s.sh");
			await bash.exec("git add s.sh");
			await bash.exec('git commit -m "Make s.sh executable"');
			return bash;
		}

		test("a pure mode change emits old/new mode header and diffstat line", async () => {
			const bash = await setupModeChange();
			const result = await bash.exec("git format-patch -1 --stdout");
			expect(result.exitCode).toBe(0);
			// diffstat summary uses git's "mode change" form, not create/delete.
			expect(result.stdout).toContain(" mode change 100644 => 100755 s.sh\n");
			expect(result.stdout).not.toContain("create mode 100755 s.sh");
			expect(result.stdout).not.toContain("delete mode 100644 s.sh");
			// The diff body is the appliable mode-only header (no hunks).
			expect(result.stdout).toContain(
				"diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n",
			);
		});
	});

	describe("binary files", () => {
		/** A repo whose single commit adds a 17-byte binary blob (hashes to 83952c4…). */
		async function setupBinary(): Promise<Bash> {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			// UTF-8 of this string is the 17 bytes 01 02 03 00 c3 bf c3 be … 00 01.
			await bash.fs.writeFile(
				"/repo/blob.bin",
				"\u0001\u0002\u0003\u0000\u00FF\u00FEPNGDATA\u0000\u0001",
			);
			await bash.exec("git add blob.bin");
			await bash.exec('git commit -m "Add binary blob"');
			return bash;
		}

		test("format-patch emits an appliable GIT binary patch with a full index", async () => {
			const bash = await setupBinary();
			const result = await bash.exec("git format-patch -1 --stdout");
			expect(result.exitCode).toBe(0);
			// Binary diffstat is unchanged (Bin sizes).
			expect(result.stdout).toContain(" blob.bin | Bin 0 -> 17 bytes\n");
			// Full 40-char index (git uses --full-index for binary), not abbreviated.
			expect(result.stdout).toContain(
				"index 0000000000000000000000000000000000000000..83952c4dabc0e8ee6b20f815ff922298af209113\n",
			);
			// The literal payload is byte-identical to git's (verified vs git 2.53.0).
			expect(result.stdout).toContain(
				"GIT binary patch\nliteral 17\nYcmZQ%VrDqJ|M0#5KX(_$5Jv_^053TO3IG5A\n\nliteral 0\nHcmV?d00001\n",
			);
			// Never the lossy, unappliable summary line.
			expect(result.stdout).not.toContain("Binary files");
		});
	});

	describe("numbering width", () => {
		/** A linear history of n commits (c1 … cn), each adding one line to f.txt. */
		async function setupNCommits(n: number): Promise<Bash> {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			for (let i = 1; i <= n; i++) {
				await bash.fs.writeFile("/repo/f.txt", `${"x\n".repeat(i)}`);
				await bash.exec("git add f.txt");
				await bash.exec(`git commit -m "Commit ${i}"`);
			}
			return bash;
		}

		test("zero-pads the sequence number to the total width for a 10+ series", async () => {
			const bash = await setupNCommits(10);
			const result = await bash.exec("git format-patch -10 --stdout");
			const subjects = result.stdout.match(/^Subject:.*/gm);
			expect(subjects?.[0]).toBe("Subject: [PATCH 01/10] Commit 1");
			expect(subjects?.[9]).toBe("Subject: [PATCH 10/10] Commit 10");
		});

		test("cover letter is patch 00, zero-padded to the total width", async () => {
			const bash = await setupNCommits(10);
			const result = await bash.exec("git format-patch -10 --cover-letter --stdout");
			expect(result.stdout).toContain("Subject: [PATCH 00/10] *** SUBJECT HERE ***");
		});
	});

	describe("MIME encoding", () => {
		test("RFC 2047 encodes non-ASCII subject and author and adds MIME headers", async () => {
			const env = {
				...TEST_ENV,
				GIT_AUTHOR_NAME: "Tëst Üser",
				GIT_COMMITTER_NAME: "Tëst Üser",
			};
			const bash = createTestBash({ files: EMPTY_REPO, env });
			await bash.exec("git init");
			await bash.fs.writeFile("/repo/f", "a\n");
			await bash.exec("git add f");
			await bash.exec('git commit -m "Café subject" -m "Bödy line."');
			const result = await bash.exec("git format-patch -1 --stdout");
			expect(result.stdout).toContain("From: =?UTF-8?q?T=C3=ABst=20=C3=9Cser?= <test@test.com>");
			expect(result.stdout).toContain("Subject: [PATCH] =?UTF-8?q?Caf=C3=A9=20subject?=");
			expect(result.stdout).toContain("MIME-Version: 1.0");
			expect(result.stdout).toContain("Content-Type: text/plain; charset=UTF-8");
			expect(result.stdout).toContain("Content-Transfer-Encoding: 8bit");
			// The body itself stays verbatim (8bit), not encoded.
			expect(result.stdout).toContain("\nBödy line.\n");
		});
	});
});
