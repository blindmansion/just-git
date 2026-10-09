import { describe, expect, test } from "bun:test";
import { EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, permissionBits, readFile, setupExecBitRepo } from "../util";

describe("git reset", () => {
	describe("--quiet", () => {
		async function setupTwoCommits() {
			const bash = createTestBash({
				files: { ...EMPTY_REPO, "/repo/b.txt": "b\n" },
				env: TEST_ENV,
			});
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "first"');
			const first = (await bash.exec("git rev-parse HEAD")).stdout.trim();
			await bash.exec("echo second > README.md");
			await bash.exec('git commit -am "second"');
			const second = (await bash.exec("git rev-parse HEAD")).stdout.trim();
			return { bash, first, second };
		}

		test("-q silences mixed reset output", async () => {
			const { bash, first } = await setupTwoCommits();
			await bash.exec("echo dirty > b.txt");

			const result = await bash.exec("git reset -q HEAD~1");
			expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await bash.exec("git rev-parse HEAD")).stdout.trim()).toBe(first);
			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toBe(" M README.md\n M b.txt\n");
		});

		test("--quiet silences mixed reset output", async () => {
			const { bash } = await setupTwoCommits();
			await bash.exec("echo dirty > b.txt");

			const result = await bash.exec("git reset --quiet HEAD");
			expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
		});

		test("--no-quiet after -q restores output", async () => {
			const { bash } = await setupTwoCommits();

			const result = await bash.exec("git reset -q --no-quiet HEAD~1");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("Unstaged changes after reset:\nM\tREADME.md\n");
		});

		test("-q silences pathspec reset output and still unstages", async () => {
			const { bash } = await setupTwoCommits();
			await bash.exec("echo dirty > b.txt");
			await bash.exec("echo staged > README.md");
			await bash.exec("git add README.md");

			const dashdash = await bash.exec("git reset -q -- README.md");
			expect(dashdash).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });

			await bash.exec("git add README.md");
			const bare = await bash.exec("git reset -q README.md");
			expect(bare).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });

			const status = await bash.exec("git status --porcelain");
			expect(status.stdout).toBe(" M README.md\n M b.txt\n");
		});

		test("-q pathspec reset still lists remaining unmerged paths", async () => {
			const { bash } = await setupTwoCommits();
			await bash.exec("echo stashed > README.md");
			await bash.exec("echo stashed > b.txt");
			await bash.exec("git stash");
			await bash.exec("echo committed > README.md");
			await bash.exec("echo committed > b.txt");
			await bash.exec('git commit -am "third"');
			expect((await bash.exec("git stash pop")).exitCode).toBe(1);

			const quiet = await bash.exec("git reset -q b.txt");
			expect(quiet).toMatchObject({ stdout: "README.md: needs merge\n", stderr: "", exitCode: 0 });

			const resolved = await bash.exec("git reset -q README.md");
			expect(resolved).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
		});

		test("-q silences 'HEAD is now at' for --hard", async () => {
			const { bash, first } = await setupTwoCommits();
			await bash.exec("echo dirty > b.txt");

			const result = await bash.exec("git reset -q --hard HEAD~1");
			expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
			expect((await bash.exec("git rev-parse HEAD")).stdout.trim()).toBe(first);
			expect(await readFile(bash.fs, "/repo/README.md")).toBe("# My Project");
			expect(await readFile(bash.fs, "/repo/b.txt")).toBe("b\n");
		});

		test("--no-quiet --hard prints 'HEAD is now at'", async () => {
			const { bash, second } = await setupTwoCommits();
			const result = await bash.exec("git reset -q --no-quiet --hard HEAD");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(`HEAD is now at ${second.slice(0, 7)} second\n`);
		});

		test("errors still print", async () => {
			const { bash } = await setupTwoCommits();

			const result = await bash.exec("git reset -q nope");
			expect(result.exitCode).toBe(128);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				"fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.\n" +
					"Use '--' to separate paths from revisions, like this:\n" +
					"'git <command> [<revision>...] -- [<file>...]'\n",
			);
		});
	});
});

describe("git reset: executable bit", () => {
	test("reset --hard restores the executable bit", async () => {
		const bash = await setupExecBitRepo();
		await bash.exec("chmod 644 run.sh");
		expect((await bash.exec("git reset --hard")).exitCode).toBe(0);
		expect(await permissionBits(bash.fs, "/repo/run.sh")).toBe(0o755);
		expect((await bash.exec("git status --short")).stdout).toBe("");
	});

	test("reset --hard <branch> clears the executable bit", async () => {
		const bash = await setupExecBitRepo();
		expect((await bash.exec("git reset --hard plain")).exitCode).toBe(0);
		expect(await permissionBits(bash.fs, "/repo/run.sh")).toBe(0o644);
		expect((await bash.exec("git status --short")).stdout).toBe("");
	});
});
