import { describe, expect, test } from "bun:test";
import type { Bash } from "just-bash";
import { EMPTY_REPO, TEST_ENV } from "../fixtures";
import { createTestBash, readFile } from "../util";

/**
 * Integration tests for `git am`, driven end-to-end through the virtual FS and
 * composed with `git format-patch`: every patch these tests apply is produced
 * by just-git's own `format-patch`, so the pair is exercised as a round trip
 * (write a series, rewind, replay it with `am`, assert the history is rebuilt).
 */

const BASE = "a\nb\nc\nd\ne\n";

/** A committed repo with `f.txt` = {@link BASE} on `main`. */
async function seed(env: Record<string, string> = TEST_ENV): Promise<Bash> {
	const bash = createTestBash({ files: EMPTY_REPO, env });
	await bash.exec("git init");
	await bash.fs.writeFile("/repo/f.txt", BASE);
	await bash.exec("git add f.txt");
	await bash.exec('git commit -m "base"');
	return bash;
}

/**
 * Commit `mutate(BASE)` as `msg`, capture its `format-patch -1 --stdout`, then
 * rewind to the base so the patch can be replayed with `am`.
 */
async function makePatch(
	bash: Bash,
	mutate: (base: string) => string,
	msg: string,
): Promise<string> {
	await bash.fs.writeFile("/repo/f.txt", mutate(BASE));
	await bash.exec("git add f.txt");
	await bash.exec(`git commit -m "${msg}"`);
	const fp = await bash.exec("git format-patch -1 --stdout");
	expect(fp.exitCode).toBe(0);
	await bash.exec("git reset --hard HEAD~1");
	return fp.stdout;
}

/** `git am` reading the mailbox from stdin (keeps the worktree clean). */
function am(bash: Bash, mbox: string, flags = "") {
	return bash.exec(`git am ${flags}`.trim(), { stdin: mbox });
}

describe("git am", () => {
	describe("happy path", () => {
		test("applies a single patch, advancing HEAD and preserving the author", async () => {
			const bash = await seed();
			const patch = await makePatch(bash, (b) => b.replace("b\n", "B\n"), "change b");

			const result = await am(bash, patch);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("Applying: change b\n");
			expect(await readFile(bash.fs, "/repo/f.txt")).toBe("a\nB\nc\nd\ne\n");

			const log = await bash.exec('git log -1 --format="%an|%ae|%s"');
			expect(log.stdout.trim()).toBe("Test|test@test.com|change b");
		});

		test("applies a multi-patch series in order", async () => {
			const bash = await seed();
			await bash.fs.writeFile("/repo/f.txt", "a\nB\nc\nd\ne\n");
			await bash.exec("git add f.txt");
			await bash.exec('git commit -m "one"');
			await bash.fs.writeFile("/repo/f.txt", "a\nB\nc\nD\ne\n");
			await bash.exec("git add f.txt");
			await bash.exec('git commit -m "two"');
			const fp = await bash.exec("git format-patch -2 --stdout");
			await bash.exec("git reset --hard HEAD~2");

			const result = await am(bash, fp.stdout);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("Applying: one\nApplying: two\n");
			expect(await readFile(bash.fs, "/repo/f.txt")).toBe("a\nB\nc\nD\ne\n");
			const subjects = await bash.exec('git log -2 --format="%s"');
			expect(subjects.stdout.trim().split("\n")).toEqual(["two", "one"]);
		});

		test("reads a patch from a file argument", async () => {
			const bash = await seed();
			const patch = await makePatch(bash, (b) => b.replace("c\n", "C\n"), "change c");
			await bash.fs.writeFile("/repo/change.patch", patch);

			const result = await bash.exec("git am change.patch");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/f.txt")).toBe("a\nb\nC\nd\ne\n");
		});
	});

	describe("secondary flags", () => {
		test("-q suppresses the Applying: progress line", async () => {
			const bash = await seed();
			const patch = await makePatch(bash, (b) => b.replace("b\n", "B\n"), "quiet one");
			const result = await am(bash, patch, "-q");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});

		test("--signoff appends a Signed-off-by trailer", async () => {
			const bash = await seed();
			const patch = await makePatch(bash, (b) => b.replace("b\n", "B\n"), "signme");
			const result = await am(bash, patch, "--signoff");
			expect(result.exitCode).toBe(0);
			const body = await bash.exec('git log -1 --format="%B"');
			expect(body.stdout).toContain("Signed-off-by: Test <test@test.com>");
		});

		test("--committer-date-is-author-date copies the author date onto the committer", async () => {
			// Distinct author/committer dates so the flag's effect is observable.
			const env = { ...TEST_ENV, GIT_AUTHOR_DATE: "1111111111", GIT_COMMITTER_DATE: "2222222222" };
			const bash = await seed(env);
			const patch = await makePatch(bash, (b) => b.replace("b\n", "B\n"), "dated");

			const plain = await am(bash, patch);
			expect(plain.exitCode).toBe(0);
			const t1 = (await bash.exec('git log -1 --format="%at|%ct"')).stdout.trim();
			expect(t1).toBe("1111111111|2222222222");

			await bash.exec("git reset --hard HEAD~1");
			const copied = await am(bash, patch, "--committer-date-is-author-date");
			expect(copied.exitCode).toBe(0);
			const t2 = (await bash.exec('git log -1 --format="%at|%ct"')).stdout.trim();
			expect(t2).toBe("1111111111|1111111111");
		});
	});

	describe("error cases", () => {
		test("outside a git repo is fatal", async () => {
			const bash = createTestBash({ files: EMPTY_REPO });
			const result = await am(bash, "whatever");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		test("no input is fatal", async () => {
			const bash = await seed();
			const result = await bash.exec("git am");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("No input file given and no patches in stdin");
		});

		test("a resume verb with no session in progress is fatal", async () => {
			const bash = await seed();
			const result = await bash.exec("git am --continue");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("Resolve operation not in progress");
		});

		test("am_setup clears a leftover REBASE_HEAD on dirty-index death", async () => {
			// Conflicted rebase leaves REBASE_HEAD + rebase-merge/; a subsequent
			// dirty-index `am` must still drop REBASE_HEAD (git's am_setup), even
			// though rebase-merge/ itself is left in place.
			const bash = await seed();
			await bash.exec("git checkout -b topic");
			await bash.fs.writeFile("/repo/f.txt", "a\ntopic\nc\nd\ne\n");
			await bash.exec("git add f.txt");
			await bash.exec('git commit -m "topic"');
			await bash.exec("git checkout main");
			await bash.fs.writeFile("/repo/f.txt", "a\nmain\nc\nd\ne\n");
			await bash.exec("git add f.txt");
			await bash.exec('git commit -m "main"');
			const rebase = await bash.exec("git rebase topic");
			expect(rebase.exitCode).toBe(1);
			expect(await bash.fs.exists("/repo/.git/REBASE_HEAD")).toBe(true);

			const patch = [
				"From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001",
				"From: Test <test@test.com>",
				"Date: Thu, 1 Jan 1970 00:00:00 +0000",
				"Subject: [PATCH] noop",
				"",
				"---",
				" f.txt | 0",
				" 1 file changed, 0 insertions(+), 0 deletions(-)",
				"",
			].join("\n");
			const result = await am(bash, patch);
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("Dirty index: cannot apply patches");
			expect(await bash.fs.exists("/repo/.git/rebase-apply/applying")).toBe(true);
			expect(await bash.fs.exists("/repo/.git/rebase-apply/dirtyindex")).toBe(true);
			expect(await bash.fs.exists("/repo/.git/rebase-merge")).toBe(true);
			expect(await bash.fs.exists("/repo/.git/REBASE_HEAD")).toBe(false);
		});
	});

	describe("conflict stop", () => {
		/** Seed, make a patch touching `b`, then commit a conflicting `b` on main. */
		async function stopOnConflict(): Promise<{
			bash: Bash;
			result: Awaited<ReturnType<typeof am>>;
		}> {
			const bash = await seed();
			const patch = await makePatch(bash, (b) => b.replace("b\n", "PATCHED\n"), "touch b");
			// Diverge the same line on the target branch so the patch won't apply.
			await bash.fs.writeFile("/repo/f.txt", "a\nLOCAL\nc\nd\ne\n");
			await bash.exec("git add f.txt");
			await bash.exec('git commit -m "local b"');
			const result = await am(bash, patch);
			return { bash, result };
		}

		test("a failing patch exits 128 and leaves the rebase-apply state dir", async () => {
			const { bash, result } = await stopOnConflict();
			expect(result.exitCode).toBe(128);
			expect(result.stdout).toContain("Applying: touch b");
			expect(result.stdout).toContain("Patch failed at 0001 touch b");
			expect(result.stderr).toContain("hint: Use 'git am --show-current-patch=diff'");
			expect(await bash.fs.exists("/repo/.git/rebase-apply")).toBe(true);
		});

		test("git status reports the in-progress am session", async () => {
			const { bash } = await stopOnConflict();
			const status = await bash.exec("git status");
			expect(status.stdout).toContain("You are in the middle of an am session.");
			expect(status.stdout).toContain("git am --continue");
			expect(status.stdout).toContain("git am --abort");
		});

		test("--show-current-patch prints the paused message", async () => {
			const { bash } = await stopOnConflict();
			const raw = await bash.exec("git am --show-current-patch");
			expect(raw.exitCode).toBe(0);
			expect(raw.stdout).toContain("Subject: [PATCH] touch b");
			const diff = await bash.exec("git am --show-current-patch=diff");
			expect(diff.stdout.startsWith("diff --git a/f.txt b/f.txt")).toBe(true);
		});

		test("--abort restores the pre-am HEAD and clears the state dir", async () => {
			const { bash } = await stopOnConflict();
			const before = (await bash.exec("git rev-parse HEAD")).stdout.trim();
			const result = await bash.exec("git am --abort");
			expect(result.exitCode).toBe(0);
			expect(await bash.fs.exists("/repo/.git/rebase-apply")).toBe(false);
			// HEAD unchanged (abort restores orig-head, which was already HEAD here).
			expect((await bash.exec("git rev-parse HEAD")).stdout.trim()).toBe(before);
			expect(await readFile(bash.fs, "/repo/f.txt")).toBe("a\nLOCAL\nc\nd\ne\n");
		});

		test("--quit drops the state dir but leaves HEAD/worktree untouched", async () => {
			const { bash } = await stopOnConflict();
			const before = (await bash.exec("git rev-parse HEAD")).stdout.trim();
			const result = await bash.exec("git am --quit");
			expect(result.exitCode).toBe(0);
			expect(await bash.fs.exists("/repo/.git/rebase-apply")).toBe(false);
			expect((await bash.exec("git rev-parse HEAD")).stdout.trim()).toBe(before);
		});

		test("--skip advances past the failing patch", async () => {
			const { bash } = await stopOnConflict();
			const result = await bash.exec("git am --skip");
			expect(result.exitCode).toBe(0);
			// Nothing was applied; the diverged worktree line is retained.
			expect(await bash.fs.exists("/repo/.git/rebase-apply")).toBe(false);
			expect(await readFile(bash.fs, "/repo/f.txt")).toBe("a\nLOCAL\nc\nd\ne\n");
		});

		test("--continue commits the resolved patch and finishes the session", async () => {
			const { bash } = await stopOnConflict();
			// Resolve by hand, then continue.
			await bash.fs.writeFile("/repo/f.txt", "a\nRESOLVED\nc\nd\ne\n");
			await bash.exec("git add f.txt");
			const result = await bash.exec("git am --continue");
			expect(result.exitCode).toBe(0);
			expect(await bash.fs.exists("/repo/.git/rebase-apply")).toBe(false);
			const log = await bash.exec('git log -1 --format="%an|%s"');
			expect(log.stdout.trim()).toBe("Test|touch b");
			expect(await readFile(bash.fs, "/repo/f.txt")).toBe("a\nRESOLVED\nc\nd\ne\n");
		});

		test("--continue without stop meta names .git/rebase-apply in the main worktree", async () => {
			const bash = await seed();
			const patch = await makePatch(bash, (b) => b.replace("b\n", "B\n"), "change b");
			await bash.fs.writeFile("/repo/f.txt", "a\nDIRTY\nc\nd\ne\n");
			await bash.exec("git add f.txt");
			const start = await am(bash, patch);
			expect(start.exitCode).toBe(128);
			expect(start.stderr).toContain("Dirty index: cannot apply patches");

			const cont = await bash.exec("git am --continue");
			expect(cont.exitCode).toBe(128);
			expect(cont.stderr).toBe(
				"fatal: cannot resume: .git/rebase-apply/final-commit does not exist.\n",
			);
		});

		test("--continue without stop meta uses the absolute admin path in a linked worktree", async () => {
			const bash = await seed();
			const patch = await makePatch(bash, (b) => b.replace("b\n", "B\n"), "change b");
			await bash.exec("git worktree add /wt -b topic");
			await bash.fs.writeFile("/wt/f.txt", "a\nDIRTY\nc\nd\ne\n");
			await bash.exec("git add f.txt", { cwd: "/wt" });
			const start = await bash.exec("git am", { cwd: "/wt", stdin: patch });
			expect(start.exitCode).toBe(128);
			expect(start.stderr).toContain("Dirty index: cannot apply patches");

			const cont = await bash.exec("git am --continue", { cwd: "/wt" });
			expect(cont.exitCode).toBe(128);
			expect(cont.stderr).toBe(
				"fatal: cannot resume: /repo/.git/worktrees/wt/rebase-apply/final-commit does not exist.\n",
			);

			const again = await bash.exec("git am", { cwd: "/wt", stdin: patch });
			expect(again.exitCode).toBe(128);
			expect(again.stderr).toBe(
				"fatal: previous rebase directory /repo/.git/worktrees/wt/rebase-apply still exists but mbox given.\n",
			);
		});
	});

	describe("-3 / --3way", () => {
		test("cleanly merges when the conflict is on a different line", async () => {
			const bash = await seed();
			// Patch touches `b`; target diverges on `d` — a clean 3-way merge.
			const patch = await makePatch(bash, (b) => b.replace("b\n", "B3\n"), "3way b");
			await bash.fs.writeFile("/repo/f.txt", "a\nb\nc\nD-local\ne\n");
			await bash.exec("git add f.txt");
			await bash.exec('git commit -m "local d"');

			const result = await am(bash, patch, "-3");
			expect(result.exitCode).toBe(0);
			expect(await readFile(bash.fs, "/repo/f.txt")).toBe("a\nB3\nc\nD-local\ne\n");
		});

		test("stops with conflict markers when both sides touch the same line", async () => {
			const bash = await seed();
			const patch = await makePatch(bash, (b) => b.replace("b\n", "THEIRS\n"), "3way conflict");
			await bash.fs.writeFile("/repo/f.txt", "a\nOURS\nc\nd\ne\n");
			await bash.exec("git add f.txt");
			await bash.exec('git commit -m "local b"');

			const result = await am(bash, patch, "-3");
			expect(result.exitCode).toBe(128);
			expect(result.stdout).toContain("Falling back to patching base and 3-way merge");
			const content = await readFile(bash.fs, "/repo/f.txt");
			expect(content).toContain("<<<<<<<");
			expect(content).toContain(">>>>>>>");
		});
	});
});
