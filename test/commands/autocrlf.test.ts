import { describe, expect, test } from "bun:test";
import type { Bash } from "just-bash";
import { TEST_ENV } from "../fixtures";
import { createTestBash } from "../util";

/**
 * core.autocrlf line-ending conversion.
 *
 * With autocrlf=true (the Git-for-Windows default), real git normalizes
 * CRLF → LF on checkin and when hashing worktree content for comparison,
 * and converts LF → CRLF on checkout. Without this, every CRLF file in a
 * Windows checkout shows as perpetually modified with a whole-file diff.
 */

async function setupRepo(commands: string[] = []): Promise<Bash> {
	const bash = createTestBash({ files: {}, cwd: "/repo", env: TEST_ENV });
	await bash.exec("git init");
	for (const cmd of commands) {
		await bash.exec(cmd);
	}
	return bash;
}

/** LF blob committed, CRLF worktree — the state of a Windows checkout. */
async function setupWindowsCheckout(): Promise<Bash> {
	const bash = await setupRepo(["git config core.autocrlf true"]);
	await bash.fs.writeFile("/repo/file.txt", "line1\nline2\n");
	await bash.exec("git add file.txt");
	await bash.exec('git commit -m "init"');
	await bash.fs.writeFile("/repo/file.txt", "line1\r\nline2\r\n");
	return bash;
}

describe("core.autocrlf", () => {
	describe("worktree comparison (clean)", () => {
		test("status is clean for a CRLF worktree file with an LF blob", async () => {
			const bash = await setupWindowsCheckout();
			const status = await bash.exec("git status --short");
			expect(status.stdout).toBe("");
		});

		test("diff and diff --stat are empty", async () => {
			const bash = await setupWindowsCheckout();
			expect((await bash.exec("git diff")).stdout).toBe("");
			expect((await bash.exec("git diff --stat")).stdout).toBe("");
		});

		test("ls-files -m does not list the file", async () => {
			const bash = await setupWindowsCheckout();
			expect((await bash.exec("git ls-files -m")).stdout).toBe("");
		});

		test("a real modification is still detected, with a normalized diff", async () => {
			const bash = await setupWindowsCheckout();
			await bash.fs.writeFile("/repo/file.txt", "line1\r\nCHANGED\r\n");
			expect((await bash.exec("git status --short")).stdout).toBe(" M file.txt\n");
			const diff = (await bash.exec("git diff")).stdout;
			// One-line change, not a whole-file CRLF rewrite
			expect(diff).toContain("-line2\n");
			expect(diff).toContain("+CHANGED\n");
			expect(diff).not.toContain("-line1");
		});

		test("without autocrlf, the CRLF file shows as modified", async () => {
			const bash = await setupWindowsCheckout();
			await bash.exec("git config core.autocrlf false");
			expect((await bash.exec("git status --short")).stdout).toBe(" M file.txt\n");
		});
	});

	describe("checkin (add)", () => {
		test("add normalizes CRLF to LF, so nothing is staged", async () => {
			const bash = await setupWindowsCheckout();
			await bash.exec("git add file.txt");
			expect((await bash.exec("git diff --cached")).stdout).toBe("");
			expect((await bash.exec("git status --short")).stdout).toBe("");
		});

		test("a new CRLF file is committed with LF content", async () => {
			const bash = await setupRepo(["git config core.autocrlf true"]);
			await bash.fs.writeFile("/repo/new.txt", "a\r\nb\r\n");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new"');
			const show = await bash.exec("git show HEAD:new.txt");
			expect(show.stdout).toBe("a\nb\n");
		});

		test("index stat size records the CRLF worktree size", async () => {
			const bash = await setupRepo(["git config core.autocrlf true"]);
			await bash.fs.writeFile("/repo/new.txt", "a\r\nb\r\n");
			await bash.exec("git add new.txt");

			const index = await bash.fs.readFileBuffer("/repo/.git/index");
			// DIRC header is 12 bytes; entry size is at offset 36.
			expect(new DataView(index.buffer, index.byteOffset).getUint32(12 + 36)).toBe(6);
		});

		test("autocrlf=input also normalizes on checkin", async () => {
			const bash = await setupRepo(["git config core.autocrlf input"]);
			await bash.fs.writeFile("/repo/new.txt", "a\r\nb\r\n");
			await bash.exec("git add new.txt");
			await bash.exec('git commit -m "add new"');
			expect((await bash.exec("git show HEAD:new.txt")).stdout).toBe("a\nb\n");
		});

		test("binary content is never normalized", async () => {
			const bash = await setupRepo(["git config core.autocrlf true"]);
			const bytes = new Uint8Array([0x41, 0x0d, 0x0a, 0x00, 0x42]);
			await bash.fs.writeFile("/repo/bin.dat", bytes);
			await bash.exec("git add bin.dat");
			await bash.exec('git commit -m "bin"');
			expect((await bash.exec("git status --short")).stdout).toBe("");
			// Round-trip through checkout preserves the exact bytes
			await bash.fs.rm("/repo/bin.dat");
			await bash.exec("git checkout -- bin.dat");
			const restored = await bash.fs.readFileBuffer("/repo/bin.dat");
			expect(Array.from(restored)).toEqual(Array.from(bytes));
		});
	});

	describe("checkout (smudge)", () => {
		test("autocrlf=true writes CRLF on checkout", async () => {
			const bash = await setupWindowsCheckout();
			await bash.fs.rm("/repo/file.txt");
			await bash.exec("git checkout -- file.txt");
			expect(await bash.fs.readFile("/repo/file.txt")).toBe("line1\r\nline2\r\n");
			// And the fresh checkout is clean
			expect((await bash.exec("git status --short")).stdout).toBe("");
		});

		test("autocrlf=input keeps LF on checkout", async () => {
			const bash = await setupRepo(["git config core.autocrlf input"]);
			await bash.fs.writeFile("/repo/f.txt", "x\r\ny\r\n");
			await bash.exec("git add f.txt");
			await bash.exec('git commit -m "f"');
			await bash.fs.rm("/repo/f.txt");
			await bash.exec("git checkout -- f.txt");
			expect(await bash.fs.readFile("/repo/f.txt")).toBe("x\ny\n");
		});
	});

	describe("renormalization guard (repo deliberately contains CRLF)", () => {
		/** Commit CRLF content with autocrlf off, then turn it on. */
		async function setupCrlfRepo(): Promise<Bash> {
			const bash = await setupRepo();
			await bash.fs.writeFile("/repo/dos.txt", "a\r\nb\r\n");
			await bash.exec("git add dos.txt");
			await bash.exec('git commit -m "dos"');
			await bash.exec("git config core.autocrlf true");
			return bash;
		}

		test("an unmodified CRLF-committed file stays clean", async () => {
			const bash = await setupCrlfRepo();
			expect((await bash.exec("git status --short")).stdout).toBe("");
			expect((await bash.exec("git diff")).stdout).toBe("");
		});

		test("add does not renormalize a CRLF-committed file", async () => {
			const bash = await setupCrlfRepo();
			await bash.exec("git add dos.txt");
			expect((await bash.exec("git diff --cached")).stdout).toBe("");
		});

		test("a modification to a CRLF-committed file stages raw CRLF bytes", async () => {
			const bash = await setupCrlfRepo();
			await bash.fs.writeFile("/repo/dos.txt", "a\r\nc\r\n");
			const diff = (await bash.exec("git diff")).stdout;
			// Both sides keep CRLF: a one-line change, no normalization noise
			expect(diff).toContain("-b\r\n");
			expect(diff).toContain("+c\r\n");
			expect(diff).not.toContain("-a");
			await bash.exec("git add dos.txt");
			await bash.exec('git commit -m "change"');
			expect((await bash.exec("git show HEAD:dos.txt")).stdout).toBe("a\r\nc\r\n");
		});
	});

	describe("commands built on worktree comparison", () => {
		test("rm does not refuse a CRLF-clean file", async () => {
			const bash = await setupWindowsCheckout();
			const rm = await bash.exec("git rm file.txt");
			expect(rm.exitCode).toBe(0);
		});

		test("branch switch is not blocked by a CRLF-clean file", async () => {
			const bash = await setupWindowsCheckout();
			await bash.exec("git checkout -b other");
			await bash.fs.writeFile("/repo/file.txt", "line1\nother\n");
			await bash.exec("git add file.txt");
			await bash.exec('git commit -m "other"');
			const toMain = await bash.exec("git checkout main");
			// main's checkout wrote CRLF (smudge); switching again must not
			// report "would be overwritten by checkout"
			const sw = await bash.exec("git checkout other");
			expect(sw.exitCode).toBe(0);
			expect(toMain.stdout).toBe("");
			expect(sw.stdout).toBe("");
			expect(await bash.fs.readFile("/repo/file.txt")).toBe("line1\r\nother\r\n");
		});

		test("stash reports no changes for a clean CRLF checkout", async () => {
			const bash = await setupWindowsCheckout();
			const stash = await bash.exec("git stash");
			expect(stash.exitCode).toBe(0);
			expect(stash.stdout).toBe("No local changes to save\n");
		});

		test("stash pop accepts a clean CRLF file it will update", async () => {
			const bash = await setupWindowsCheckout();
			await bash.fs.writeFile("/repo/file.txt", "line1\r\nchanged\r\n");
			expect((await bash.exec("git stash")).exitCode).toBe(0);
			expect((await bash.exec("git status --short")).stdout).toBe("");

			const pop = await bash.exec("git stash pop");
			expect(pop.exitCode).toBe(0);
			expect(await bash.fs.readFile("/repo/file.txt")).toBe("line1\r\nchanged\r\n");
			expect((await bash.exec("git status --short")).stdout).toBe(" M file.txt\n");
		});

		test("stash and pop round-trip cleanly with a CRLF worktree", async () => {
			const bash = await setupWindowsCheckout();
			await bash.fs.writeFile("/repo/other.txt", "real change\n");
			await bash.exec("git add other.txt");
			const stash = await bash.exec("git stash -u");
			expect(stash.exitCode).toBe(0);
			expect((await bash.exec("git status --short")).stdout).toBe("");
			const pop = await bash.exec("git stash pop");
			expect(pop.exitCode).toBe(0);
			const status = (await bash.exec("git status --short")).stdout;
			expect(status).toContain("other.txt");
			expect(status).not.toContain("file.txt");
		});
	});
});
