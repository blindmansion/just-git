import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, symlinkSync } from "fs";
import { join } from "path";
import { createSandbox, jg, justBash, realGit, removeSandbox, writeToSandbox } from "./util";

const GITLINK = "1111111111111111111111111111111111111111";

const CASES: { cwd: string; args: string }[] = [
	{ cwd: "", args: "HEAD" },
	{ cwd: "", args: "-r HEAD" },
	{ cwd: "", args: "-d HEAD" },
	{ cwd: "", args: "-r -d HEAD" },
	{ cwd: "", args: "-t HEAD" },
	{ cwd: "", args: "-r -t HEAD" },
	{ cwd: "", args: "-r --name-only HEAD" },
	{ cwd: "", args: "--name-status HEAD" },
	{ cwd: "", args: "-r -z HEAD" },
	{ cwd: "", args: "-r --name-only -z HEAD" },
	{ cwd: "", args: "--abbrev HEAD" },
	{ cwd: "", args: "--abbrev=4 -r HEAD" },
	{ cwd: "", args: "--abbrev=0 HEAD" },
	{ cwd: "", args: "HEAD src" },
	{ cwd: "", args: "HEAD src/" },
	{ cwd: "", args: "HEAD -- src/lib/math.ts" },
	{ cwd: "", args: "-t HEAD src/lib/math.ts" },
	{ cwd: "", args: "-d -t HEAD src/lib/math.ts" },
	{ cwd: "", args: "HEAD src docs/guide.md" },
	{ cwd: "", args: "-d HEAD src/" },
	{ cwd: "", args: "HEAD vendor/mod" },
	{ cwd: "", args: "HEAD vendor/mod/" },
	{ cwd: "", args: "-d HEAD vendor/" },
	{ cwd: "", args: "HEAD README.md/" },
	{ cwd: "", args: "HEAD 'sp*'" },
	{ cwd: "", args: "HEAD nope" },
	{ cwd: "", args: "HEAD^{tree} docs/" },
	{ cwd: "", args: "v1 docs/" },
	{ cwd: "", args: "bogus" },
	{ cwd: "src", args: "HEAD" },
	{ cwd: "src", args: "-r HEAD" },
	{ cwd: "src", args: "-r -t HEAD" },
	{ cwd: "src", args: "HEAD ." },
	{ cwd: "src", args: "HEAD .." },
	{ cwd: "src", args: "HEAD lib" },
	{ cwd: "src", args: "HEAD ../docs/" },
	{ cwd: "src", args: "--full-tree HEAD" },
	{ cwd: "src", args: "--full-tree HEAD src/" },
	{ cwd: "src", args: "-r --full-tree HEAD lib" },
	{ cwd: "src/lib", args: "-r --name-only HEAD ../../" },
	{ cwd: "src/lib", args: "HEAD ../../" },
	{ cwd: "src/lib", args: "-r -d HEAD ../../" },
	{ cwd: "src/lib", args: "-r -t HEAD .." },
	{ cwd: "", args: "HEAD ''" },
	{ cwd: "src", args: "HEAD ../../x ''" },
	{ cwd: "", args: "-- HEAD" },
	{ cwd: "", args: "-r -- HEAD" },
	{ cwd: "", args: "-- HEAD src" },
	{ cwd: "", args: "-- HEAD -- src" },
	{ cwd: "", args: "-- bogus" },
];

describe("interop: git ls-tree matches real git", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		writeToSandbox(sandbox, "README.md", "a\n");
		writeToSandbox(sandbox, "src/main.ts", "b\n");
		writeToSandbox(sandbox, "src/lib/math.ts", "c\n");
		writeToSandbox(sandbox, "docs/guide.md", "d\n");
		writeToSandbox(sandbox, "sp ace.txt", "e\n");
		writeToSandbox(sandbox, "é.txt", "f\n");
		writeToSandbox(sandbox, 'q"uote.txt', "g\n");
		writeToSandbox(sandbox, "tab\tname", "h\n");
		writeToSandbox(sandbox, "run.sh", "#!/bin/sh\n");
		chmodSync(join(sandbox, "run.sh"), 0o755);
		symlinkSync("README.md", join(sandbox, "link"));
		for (const cmd of [
			"init",
			"add -A",
			`update-index --add --cacheinfo 160000,${GITLINK},vendor/mod`,
			"commit -m initial",
			"tag -a v1 -m v1",
		]) {
			const r = await realGit(sandbox, cmd);
			expect(r.exitCode).toBe(0);
		}
	});
	afterAll(() => removeSandbox(sandbox));

	for (const { cwd, args } of CASES) {
		test(`${cwd || "."}: git ls-tree ${args}`, async () => {
			const expected = await realGit(sandbox, `${cwd ? `-C ${cwd} ` : ""}ls-tree ${args}`);
			const actual = await jg(
				justBash(sandbox),
				`${cwd ? `cd ${cwd} && ` : ""}git ls-tree ${args}`,
			);
			expect({ stdout: actual.stdout, stderr: actual.stderr, exitCode: actual.exitCode }).toEqual(
				expected,
			);
		});
	}

	test("a tree entry that points at a blob fails like git", async () => {
		const readmeBlob = (await realGit(sandbox, "rev-parse HEAD:README.md")).stdout.trim();
		writeToSandbox(
			sandbox,
			".git/bad-tree",
			Buffer.concat([Buffer.from("40000 bad\0"), Buffer.from(readmeBlob, "hex")]),
		);
		const badTree = (
			await realGit(sandbox, "hash-object -t tree -w --literally .git/bad-tree")
		).stdout.trim();
		const expected = await realGit(sandbox, `ls-tree -r ${badTree}`);
		const actual = await jg(justBash(sandbox), `git ls-tree -r ${badTree}`);
		expect(expected).toMatchObject({ stdout: "", exitCode: 1 });
		expect({ stdout: actual.stdout, stderr: actual.stderr, exitCode: actual.exitCode }).toEqual({
			stdout: "",
			stderr: "Expected tree object, got blob",
			exitCode: 1,
		});
	});
});
