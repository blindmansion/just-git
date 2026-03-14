import { describe, expect, test } from "bun:test";
import { TEST_ENV } from "../fixtures";
import { createTestBash, pathExists, readFile, runScenario } from "../util";

async function setupLinearHistory(commitCount = 10) {
	const bash = createTestBash({
		files: { "/repo/README.md": "# Hello" },
		env: TEST_ENV,
	});
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "commit 1"');

	for (let i = 2; i <= commitCount; i++) {
		await bash.fs.writeFile(`/repo/file${i}.txt`, `content ${i}`);
		await bash.exec("git add .");
		await bash.exec(`git commit -m "commit ${i}"`);
	}

	return bash;
}

describe("git bisect", () => {
	describe("not a repo", () => {
		test("fails with exit 128", async () => {
			const { results } = await runScenario(["git bisect start"], {
				files: { "/repo/README.md": "# Hello" },
			});
			expect(results[0]!.exitCode).toBe(128);
			expect(results[0]!.stderr).toContain("not a git repository");
		});
	});

	describe("start", () => {
		test("bare start shows waiting status", async () => {
			const bash = await setupLinearHistory();
			const result = await bash.exec("git bisect start");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("waiting for both good and bad commits");
		});

		test("start with bad and good revisions auto-bisects", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			const result = await bash.exec(`git bisect start HEAD ${firstHash}`);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Bisecting:");
			expect(result.stdout).toContain("revisions left to test");
		});

		test("start resets previous bisect session", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);
			const result = await bash.exec(`git bisect start HEAD ${firstHash}`);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Bisecting:");
		});
	});

	describe("bad/good marking", () => {
		test("marking bad then good starts bisecting", async () => {
			const bash = await setupLinearHistory();
			await bash.exec("git bisect start");

			const r1 = await bash.exec("git bisect bad");
			expect(r1.exitCode).toBe(0);
			expect(r1.stdout).toContain("waiting for good commit(s), bad commit known");

			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			const r2 = await bash.exec(`git bisect good ${firstHash}`);
			expect(r2.exitCode).toBe(0);
			expect(r2.stdout).toContain("Bisecting:");
		});

		test("error when not bisecting", async () => {
			const bash = await setupLinearHistory();
			const result = await bash.exec("git bisect good");
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain('You need to start by "git bisect start"');
		});

		test("bad error when not bisecting", async () => {
			const bash = await setupLinearHistory();
			const result = await bash.exec("git bisect bad");
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain('You need to start by "git bisect start"');
		});
	});

	describe("full bisect session", () => {
		test("finds first bad commit in linear history", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);

			// Keep marking good until we find the first bad commit
			let found = false;
			for (let i = 0; i < 15; i++) {
				const result = await bash.exec("git bisect good");
				if (result.stdout.includes("is the first bad commit")) {
					found = true;
					break;
				}
				expect(result.exitCode).toBe(0);
			}
			expect(found).toBe(true);
		});

		test("bisect narrows down with mixed good/bad", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			const startResult = await bash.exec(`git bisect start HEAD ${firstHash}`);
			expect(startResult.exitCode).toBe(0);
			expect(startResult.stdout).toContain("Bisecting:");

			// Keep bisecting until done
			let done = false;
			for (let i = 0; i < 15; i++) {
				// Alternate good and bad to exercise the algorithm
				const cmd = i % 3 === 0 ? "git bisect bad" : "git bisect good";
				const result = await bash.exec(cmd);
				if (result.stdout.includes("is the first bad commit")) {
					done = true;
					break;
				}
				expect(result.exitCode).toBe(0);
			}
			expect(done).toBe(true);
		});
	});

	describe("skip", () => {
		test("skip advances to a different commit", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);
			const skipResult = await bash.exec("git bisect skip");
			expect(skipResult.exitCode).toBe(0);
			expect(skipResult.stdout).toContain("Bisecting:");
		});
	});

	describe("reset", () => {
		test("resets back to original branch", async () => {
			const bash = await setupLinearHistory();

			// Verify we're on a branch before bisect
			const headBefore = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(headBefore).toContain("refs/heads/");

			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);

			// HEAD should now be detached
			const headDuring = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(headDuring).not.toContain("refs/heads/");

			const resetResult = await bash.exec("git bisect reset");
			expect(resetResult.exitCode).toBe(0);

			// Should be back on branch
			const headAfter = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(headAfter).toContain("refs/heads/");

			// State files should be cleaned up
			expect(await pathExists(bash.fs, "/repo/.git/BISECT_START")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/.git/BISECT_LOG")).toBe(false);
			expect(await pathExists(bash.fs, "/repo/.git/BISECT_TERMS")).toBe(false);
		});

		test("reset when not bisecting says so", async () => {
			const bash = await setupLinearHistory();
			const result = await bash.exec("git bisect reset");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("We are not bisecting.");
		});
	});

	describe("log", () => {
		test("shows bisect log", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);
			await bash.exec("git bisect good");

			const bisectLog = await bash.exec("git bisect log");
			expect(bisectLog.exitCode).toBe(0);
			expect(bisectLog.stdout).toContain("git bisect start");
			expect(bisectLog.stdout).toContain("git bisect good");
		});

		test("error when not bisecting", async () => {
			const bash = await setupLinearHistory();
			const result = await bash.exec("git bisect log");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("We are not bisecting");
		});
	});

	describe("terms", () => {
		test("shows default terms", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);
			const result = await bash.exec("git bisect terms");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("good");
			expect(result.stdout).toContain("bad");
		});

		test("shows custom terms", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start --term-new=broken --term-old=fixed HEAD ${firstHash}`);
			const result = await bash.exec("git bisect terms");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("fixed");
			expect(result.stdout).toContain("broken");
		});

		test("--term-good shows good term", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);
			const result = await bash.exec("git bisect terms --term-good");
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("good");
		});

		test("--term-bad shows bad term", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);
			const result = await bash.exec("git bisect terms --term-bad");
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("bad");
		});

		test("error when not bisecting", async () => {
			const bash = await setupLinearHistory();
			const result = await bash.exec("git bisect terms");
			expect(result.exitCode).toBe(1);
		});
	});

	describe("custom terms", () => {
		test("bisect with --term-new/--term-old", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			const result = await bash.exec(
				`git bisect start --term-new=broken --term-old=fixed HEAD ${firstHash}`,
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Bisecting:");

			// Use custom terms
			const fixedResult = await bash.exec("git bisect fixed");
			expect(fixedResult.exitCode).toBe(0);
		});
	});

	describe("new/old aliases", () => {
		test("new and old work as bad/good aliases", async () => {
			const bash = await setupLinearHistory();
			await bash.exec("git bisect start");

			const r1 = await bash.exec("git bisect new");
			expect(r1.exitCode).toBe(0);
			expect(r1.stdout).toContain("waiting for");

			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			const r2 = await bash.exec(`git bisect old ${firstHash}`);
			expect(r2.exitCode).toBe(0);
			expect(r2.stdout).toContain("Bisecting:");
		});
	});

	describe("state files", () => {
		test("creates expected state files", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);

			expect(await pathExists(bash.fs, "/repo/.git/BISECT_START")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/.git/BISECT_LOG")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/.git/BISECT_TERMS")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/.git/BISECT_NAMES")).toBe(true);
			expect(await pathExists(bash.fs, "/repo/.git/BISECT_EXPECTED_REV")).toBe(true);

			const terms = await readFile(bash.fs, "/repo/.git/BISECT_TERMS");
			expect(terms).toContain("bad");
			expect(terms).toContain("good");

			const start = await readFile(bash.fs, "/repo/.git/BISECT_START");
			expect(start!.trim()).toBe("main");
		});

		test("creates bisect refs", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);

			expect(await pathExists(bash.fs, "/repo/.git/refs/bisect/bad")).toBe(true);

			// Should have a good ref with the hash as suffix
			const bisectDir = await bash.fs.readdir("/repo/.git/refs/bisect");
			const goodRefs = bisectDir.filter((f: string) => f.startsWith("good-"));
			expect(goodRefs.length).toBe(1);
		});
	});

	describe("status integration", () => {
		test("git status shows bisecting indicator", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);
			const result = await bash.exec("git status");
			expect(result.stdout).toContain("You are currently bisecting");
			expect(result.stdout).toContain("git bisect reset");
		});
	});

	describe("visualize", () => {
		test("shows commits in bisect range", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);
			const result = await bash.exec("git bisect visualize");
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n").length).toBeGreaterThan(1);
		});

		test("view is an alias for visualize", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);
			const result = await bash.exec("git bisect view");
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n").length).toBeGreaterThan(1);
		});
	});

	describe("replay", () => {
		test("replays a bisect log", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			// Do a partial bisect session
			await bash.exec(`git bisect start HEAD ${firstHash}`);
			await bash.exec("git bisect good");

			// Save the log
			const logContent = await bash.exec("git bisect log");
			await bash.fs.writeFile("/repo/bisect.log", logContent.stdout);

			// Reset
			await bash.exec("git bisect reset");

			// Replay
			const replayResult = await bash.exec("git bisect replay /repo/bisect.log");
			expect(replayResult.exitCode).toBe(0);

			// Should be bisecting again
			expect(await pathExists(bash.fs, "/repo/.git/BISECT_START")).toBe(true);
			await bash.exec("git bisect reset");
		});
	});

	describe("run", () => {
		test("automatically bisects using a test command", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			await bash.exec(`git bisect start HEAD ${firstHash}`);

			// Write a test script that checks for file6.txt
			await bash.fs.writeFile(
				"/repo/test.sh",
				"#!/bin/bash\nif [ -f /repo/file6.txt ]; then exit 1; else exit 0; fi\n",
			);

			const runResult = await bash.exec("git bisect run bash /repo/test.sh");
			expect(runResult.exitCode).toBe(0);
			expect(runResult.stdout).toContain("is the first bad commit");
			expect(runResult.stdout).toContain("bisect found first bad commit");
		});
	});

	describe("merge topology", () => {
		test("bisects across merge commits", async () => {
			const bash = createTestBash({
				files: { "/repo/README.md": "# Hello" },
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Create some commits on main
			for (let i = 2; i <= 5; i++) {
				await bash.fs.writeFile(`/repo/file${i}.txt`, `content ${i}`);
				await bash.exec("git add .");
				await bash.exec(`git commit -m "commit ${i}"`);
			}

			// Create a branch and add commits
			await bash.exec("git checkout -b feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature content");
			await bash.exec("git add .");
			await bash.exec('git commit -m "feature commit"');

			// Merge back
			await bash.exec("git checkout main");
			await bash.exec("git merge feature --no-ff -m 'merge feature'");

			// Add more commits
			for (let i = 6; i <= 8; i++) {
				await bash.fs.writeFile(`/repo/file${i}.txt`, `content ${i}`);
				await bash.exec("git add .");
				await bash.exec(`git commit -m "commit ${i}"`);
			}

			const logResult = await bash.exec("git log --oneline");
			const allLines = logResult.stdout.trim().split("\n");
			const firstHash = allLines[allLines.length - 1]!.split(" ")[0]!;

			const startResult = await bash.exec(`git bisect start HEAD ${firstHash}`);
			expect(startResult.exitCode).toBe(0);
			expect(startResult.stdout).toContain("Bisecting:");

			// Complete the bisect
			let found = false;
			for (let i = 0; i < 20; i++) {
				const result = await bash.exec("git bisect good");
				if (result.stdout.includes("is the first bad commit")) {
					found = true;
					break;
				}
			}
			expect(found).toBe(true);
		});
	});

	describe("no-checkout mode", () => {
		test("uses BISECT_HEAD instead of detaching", async () => {
			const bash = await setupLinearHistory();
			const logResult = await bash.exec("git log --oneline");
			const lines = logResult.stdout.trim().split("\n");
			const firstHash = lines[lines.length - 1]!.split(" ")[0]!;

			// Store HEAD before
			const headBefore = await readFile(bash.fs, "/repo/.git/HEAD");

			await bash.exec(`git bisect start --no-checkout HEAD ${firstHash}`);

			// HEAD should not have changed (still on branch)
			const headAfter = await readFile(bash.fs, "/repo/.git/HEAD");
			expect(headAfter).toBe(headBefore);

			// BISECT_HEAD should exist
			expect(await pathExists(bash.fs, "/repo/.git/BISECT_HEAD")).toBe(true);
		});
	});

	describe("edge cases", () => {
		test("bare git bisect shows usage", async () => {
			const bash = await setupLinearHistory();
			const result = await bash.exec("git bisect");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("usage:");
		});

		test("reserved terms are rejected", async () => {
			const bash = await setupLinearHistory();
			const result = await bash.exec("git bisect start --term-new=start");
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a valid term");
		});

		test("same terms are rejected", async () => {
			const bash = await setupLinearHistory();
			const result = await bash.exec("git bisect start --term-new=foo --term-old=foo");
			expect(result.exitCode).toBe(128);
		});
	});
});
