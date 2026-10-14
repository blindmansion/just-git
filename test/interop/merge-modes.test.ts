import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, readFileSync } from "fs";
import { join } from "path";
import {
	createSandbox,
	jg,
	justBash,
	realGit,
	realGitIn,
	removeSandbox,
	writeToSandbox,
} from "./util";

// The repository from issue #18. Ours edits f and makes p executable. Theirs
// edits f and p and makes f and m executable. `other` edits f so that it
// conflicts with theirs.
describe("interop: merge keeps a mode change from either side", () => {
	let source: string;
	const copies: string[] = [];

	beforeAll(async () => {
		source = createSandbox();
		const git = realGitIn(source);
		const write = (path: string, content: string, mode = 0o644) => {
			writeToSandbox(source, path, content);
			chmodSync(join(source, path), mode);
		};
		const commit = async (message: string) => {
			await git.execAsync(["add", "-A"]);
			await git.execAsync(["commit", "-q", "-m", message]);
		};

		await git.execAsync(["init", "-q", "-b", "main"]);
		write("f", "1\n2\n3\n4\n5\n");
		write("m", "k\n");
		write("p", "q\n");
		await commit("base");
		write("f", "O\n2\n3\n4\n5\n");
		write("p", "q\n", 0o755);
		write("z", "z\n");
		await commit("ours");
		await git.execAsync(["checkout", "-q", "-b", "theirs", "main~1"]);
		write("f", "1\n2\n3\n4\nT\n", 0o755);
		write("m", "k\n", 0o755);
		write("p", "q\nT\n");
		await commit("theirs");
		await git.execAsync(["checkout", "-q", "-b", "other", "main~1"]);
		write("f", "X\n2\n3\n4\nX\n");
		await commit("other");
	});
	afterAll(() => {
		removeSandbox(source);
		for (const dir of copies) removeSandbox(dir);
	});

	async function checkoutCopy(branch: string): Promise<string> {
		const dir = createSandbox();
		copies.push(dir);
		cpSync(source, dir, { recursive: true });
		await realGitIn(dir).execAsync(["checkout", "-q", branch]);
		return dir;
	}

	async function mergeBoth(branch: string) {
		const realDir = await checkoutCopy(branch);
		const jgDir = await checkoutCopy(branch);
		const expected = await realGit(realDir, "merge -m merge theirs");
		const actual = await jg(justBash(jgDir), "git merge -m merge theirs");
		return { realDir, jgDir, expected, actual };
	}

	test("clean merge", async () => {
		const { realDir, jgDir, expected, actual } = await mergeBoth("main");
		expect(expected.exitCode).toBe(0);
		expect({ stdout: actual.stdout, stderr: actual.stderr, exitCode: actual.exitCode }).toEqual(
			expected,
		);
		const realIndex = await realGit(realDir, "ls-files -s");
		expect(realIndex.stdout).toContain("100755 b68fde2a051d9af2fe3ff4c96c0898e5a3212e4d 0\tm\n");
		expect(await realGit(jgDir, "ls-files -s")).toEqual(realIndex);
	});

	test("conflicted merge", async () => {
		const { realDir, jgDir, expected, actual } = await mergeBoth("other");
		expect(expected.exitCode).toBe(1);
		expect({ stdout: actual.stdout, stderr: actual.stderr, exitCode: actual.exitCode }).toEqual(
			expected,
		);
		expect(await realGit(jgDir, "ls-files -s")).toEqual(await realGit(realDir, "ls-files -s"));
		expect(readFileSync(join(jgDir, "f"), "utf8")).toBe(readFileSync(join(realDir, "f"), "utf8"));
	});
});
