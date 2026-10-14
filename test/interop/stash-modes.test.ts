import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, statSync } from "fs";
import { join } from "path";
import { createSandbox, jg, justBash, realGit, removeSandbox, writeToSandbox } from "./util";

describe("interop: stash keeps a chmod-only change", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs) removeSandbox(dir);
	});

	async function repo(): Promise<string> {
		const dir = createSandbox();
		dirs.push(dir);
		writeToSandbox(dir, "f", "hi\n");
		writeToSandbox(dir, "g", "other\n");
		for (const cmd of ["init -q -b main", "add .", "commit -q -m init"]) {
			expect((await realGit(dir, cmd)).exitCode).toBe(0);
		}
		chmodSync(join(dir, "f"), 0o755);
		return dir;
	}

	function copy(dir: string): string {
		const out = createSandbox();
		dirs.push(out);
		cpSync(dir, out, { recursive: true });
		return out;
	}

	const perm = (dir: string) => statSync(join(dir, "f")).mode & 0o777;

	async function expectSameState(jgDir: string, realDir: string) {
		expect(perm(jgDir)).toBe(perm(realDir));
		for (const cmd of ["ls-files -s", "status --porcelain", "stash list"]) {
			expect(await realGit(jgDir, cmd)).toEqual(await realGit(realDir, cmd));
		}
	}

	test("just-git pops a stash created by real git", async () => {
		const dir = await repo();
		expect((await realGit(dir, "stash -q")).exitCode).toBe(0);
		expect(perm(dir)).toBe(0o644);
		const jgDir = copy(dir);

		const expected = await realGit(dir, "stash pop");
		const actual = await jg(justBash(jgDir), "git stash pop");
		expect(expected.exitCode).toBe(0);
		expect({ stdout: actual.stdout, stderr: actual.stderr, exitCode: actual.exitCode }).toEqual(
			expected,
		);
		expect(perm(dir)).toBe(0o755);
		await expectSameState(jgDir, dir);
	});

	test("real git pops a stash created by just-git", async () => {
		const dir = await repo();
		const realDir = copy(dir);
		expect((await jg(justBash(dir), "git stash -q")).exitCode).toBe(0);
		expect((await realGit(realDir, "stash -q")).exitCode).toBe(0);
		expect(perm(dir)).toBe(0o644);
		expect(await realGit(dir, "stash show -p")).toEqual(await realGit(realDir, "stash show -p"));

		const expected = await realGit(realDir, "stash pop -q");
		expect(await realGit(dir, "stash pop -q")).toEqual(expected);
		await expectSameState(dir, realDir);
	});
});
