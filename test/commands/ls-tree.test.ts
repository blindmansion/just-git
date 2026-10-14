import { describe, expect, test } from "bun:test";
import { TEST_ENV } from "../fixtures";
import { runScenario } from "../util";

const README = "78981922613b2afb6025042ff6bd878ac1994e85";
const LINK = "42061c01a1c70097d1e4579f29a5adf40abdec95";
const RUN_SH = "1a2485251c33a70432394c93fb89330ef214bfc9";
const SRC = "1cc3974b97e5c169b3cb036573064b47f6658a8a";
const SRC_LIB = "e4ee6728ab8362c0569f8fbbe72224e351560992";
const MATH = "f2ad6c76f0115a6ba5b00456a849810e7ec0af20";
const MAIN = "61780798228d17af2d34fce4cfbdf35556832472";

const FILES = {
	"/repo/README.md": "a\n",
	"/repo/src/main.ts": "b\n",
	"/repo/src/lib/math.ts": "c\n",
	"/repo/run.sh": "#!/bin/sh\n",
};

async function lsTree(command: string, cwd = "/repo") {
	const { results } = await runScenario(
		[
			"git init",
			"chmod +x run.sh",
			"ln -s README.md link",
			"git add -A",
			'git commit -m "initial"',
			`cd ${cwd} && ${command}`,
		],
		{ files: FILES, env: TEST_ENV, cwd: "/repo" },
	);
	for (const r of results.slice(0, -1)) expect(r.exitCode).toBe(0);
	return results.at(-1)!;
}

function lines(...entries: string[]): string {
	return entries.map((e) => `${e}\n`).join("");
}

describe("git ls-tree", () => {
	test("lists the root tree with modes for executables, symlinks and trees", async () => {
		const r = await lsTree("git ls-tree HEAD");
		expect(r.stdout).toBe(
			lines(
				`100644 blob ${README}\tREADME.md`,
				`120000 blob ${LINK}\tlink`,
				`100755 blob ${RUN_SH}\trun.sh`,
				`040000 tree ${SRC}\tsrc`,
			),
		);
		expect(r.stderr).toBe("");
		expect(r.exitCode).toBe(0);
	});

	test("-r recurses and omits tree entries", async () => {
		const r = await lsTree("git ls-tree -r HEAD");
		expect(r.stdout).toBe(
			lines(
				`100644 blob ${README}\tREADME.md`,
				`120000 blob ${LINK}\tlink`,
				`100755 blob ${RUN_SH}\trun.sh`,
				`100644 blob ${MATH}\tsrc/lib/math.ts`,
				`100644 blob ${MAIN}\tsrc/main.ts`,
			),
		);
		expect(r.exitCode).toBe(0);
	});

	test("-r -t shows trees while recursing", async () => {
		const r = await lsTree("git ls-tree -r -t HEAD");
		expect(r.stdout).toBe(
			lines(
				`100644 blob ${README}\tREADME.md`,
				`120000 blob ${LINK}\tlink`,
				`100755 blob ${RUN_SH}\trun.sh`,
				`040000 tree ${SRC}\tsrc`,
				`040000 tree ${SRC_LIB}\tsrc/lib`,
				`100644 blob ${MATH}\tsrc/lib/math.ts`,
				`100644 blob ${MAIN}\tsrc/main.ts`,
			),
		);
	});

	test("-d shows only trees", async () => {
		const r = await lsTree("git ls-tree -d HEAD");
		expect(r.stdout).toBe(lines(`040000 tree ${SRC}\tsrc`));
	});

	test("-r -d implies -t", async () => {
		const r = await lsTree("git ls-tree -r -d HEAD");
		expect(r.stdout).toBe(lines(`040000 tree ${SRC}\tsrc`, `040000 tree ${SRC_LIB}\tsrc/lib`));
	});

	test("--name-only and --name-status print paths only", async () => {
		const expected = lines("README.md", "link", "run.sh", "src/lib/math.ts", "src/main.ts");
		expect((await lsTree("git ls-tree -r --name-only HEAD")).stdout).toBe(expected);
		expect((await lsTree("git ls-tree -r --name-status HEAD")).stdout).toBe(expected);
	});

	test("a directory path without a trailing slash shows the tree entry itself", async () => {
		const r = await lsTree("git ls-tree HEAD src");
		expect(r.stdout).toBe(lines(`040000 tree ${SRC}\tsrc`));
	});

	test("a directory path with a trailing slash lists its contents", async () => {
		const r = await lsTree("git ls-tree HEAD src/");
		expect(r.stdout).toBe(
			lines(`040000 tree ${SRC_LIB}\tsrc/lib`, `100644 blob ${MAIN}\tsrc/main.ts`),
		);
	});

	test("a file path after -- reports its mode and blob without -r", async () => {
		const r = await lsTree("git ls-tree HEAD -- src/lib/math.ts");
		expect(r.stdout).toBe(lines(`100644 blob ${MATH}\tsrc/lib/math.ts`));
	});

	test("-t with a nested path shows the leading trees", async () => {
		const r = await lsTree("git ls-tree -t HEAD src/lib/math.ts");
		expect(r.stdout).toBe(
			lines(
				`040000 tree ${SRC}\tsrc`,
				`040000 tree ${SRC_LIB}\tsrc/lib`,
				`100644 blob ${MATH}\tsrc/lib/math.ts`,
			),
		);
	});

	test("paths are literal, not globs", async () => {
		const r = await lsTree("git ls-tree HEAD 'R*'");
		expect(r.stdout).toBe("");
		expect(r.exitCode).toBe(0);
	});

	test("a path with no match prints nothing and succeeds", async () => {
		const r = await lsTree("git ls-tree HEAD missing");
		expect(r.stdout).toBe("");
		expect(r.exitCode).toBe(0);
	});

	test("from a subdirectory, lists that directory relative to the cwd", async () => {
		const r = await lsTree("git ls-tree HEAD", "/repo/src");
		expect(r.stdout).toBe(lines(`040000 tree ${SRC_LIB}\tlib`, `100644 blob ${MAIN}\tmain.ts`));
	});

	test("from a subdirectory, paths outside the cwd are shown with ../", async () => {
		const r = await lsTree("git ls-tree HEAD ../run.sh", "/repo/src");
		expect(r.stdout).toBe(lines(`100755 blob ${RUN_SH}\t../run.sh`));
	});

	test("from a nested subdirectory, ancestor trees are shown as ../ and ./", async () => {
		const r = await lsTree("git ls-tree -r -d HEAD ../../", "/repo/src/lib");
		expect(r.stdout).toBe(lines(`040000 tree ${SRC}\t../`, `040000 tree ${SRC_LIB}\t./`));
		expect(r.stderr).toBe("");
		expect(r.exitCode).toBe(0);
	});

	test("from a nested subdirectory, the root listing shows the cwd's parent as ../", async () => {
		const r = await lsTree("git ls-tree HEAD ../../", "/repo/src/lib");
		expect(r.stdout).toBe(
			lines(
				`100644 blob ${README}\t../../README.md`,
				`120000 blob ${LINK}\t../../link`,
				`100755 blob ${RUN_SH}\t../../run.sh`,
				`040000 tree ${SRC}\t../`,
			),
		);
		expect(r.exitCode).toBe(0);
	});

	test("--full-tree lists from the root with full paths", async () => {
		const r = await lsTree("git ls-tree --full-tree HEAD src/", "/repo/src");
		expect(r.stdout).toBe(
			lines(`040000 tree ${SRC_LIB}\tsrc/lib`, `100644 blob ${MAIN}\tsrc/main.ts`),
		);
	});

	test("-z terminates entries with NUL", async () => {
		const r = await lsTree("git ls-tree -z HEAD src/");
		expect(r.stdout).toBe(
			`040000 tree ${SRC_LIB}\tsrc/lib\x00100644 blob ${MAIN}\tsrc/main.ts\x00`,
		);
	});

	test("--abbrev shortens object names", async () => {
		const r = await lsTree("git ls-tree --abbrev HEAD");
		expect(r.stdout).toBe(
			lines(
				`100644 blob ${README.slice(0, 7)}\tREADME.md`,
				`120000 blob ${LINK.slice(0, 7)}\tlink`,
				`100755 blob ${RUN_SH.slice(0, 7)}\trun.sh`,
				`040000 tree ${SRC.slice(0, 7)}\tsrc`,
			),
		);
	});

	test("--abbrev=<n> uses n digits", async () => {
		const r = await lsTree("git ls-tree --abbrev=4 -r HEAD src/");
		expect(r.stdout).toBe(
			lines(
				`100644 blob ${MATH.slice(0, 4)}\tsrc/lib/math.ts`,
				`100644 blob ${MAIN.slice(0, 4)}\tsrc/main.ts`,
			),
		);
	});

	test("accepts a tree object as the tree-ish", async () => {
		const r = await lsTree(`git ls-tree ${SRC}`);
		expect(r.stdout).toBe(lines(`040000 tree ${SRC_LIB}\tlib`, `100644 blob ${MAIN}\tmain.ts`));
	});

	test("an invalid tree-ish exits 128", async () => {
		const r = await lsTree("git ls-tree bogus");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("fatal: Not a valid object name bogus\n");
		expect(r.exitCode).toBe(128);
	});

	test("a blob is not a tree object", async () => {
		const r = await lsTree(`git ls-tree ${README}`);
		expect(r.stderr).toBe("fatal: not a tree object\n");
		expect(r.exitCode).toBe(128);
	});

	test("an empty path is fatal", async () => {
		const r = await lsTree("git ls-tree HEAD ''");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(
			"fatal: empty string is not a valid pathspec. please use . instead if you meant to match all paths\n",
		);
		expect(r.exitCode).toBe(128);
	});

	test("an empty path is rejected before other paths and the tree type are checked", async () => {
		const expected =
			"fatal: empty string is not a valid pathspec. please use . instead if you meant to match all paths\n";
		expect((await lsTree("git ls-tree HEAD ../../x ''", "/repo/src")).stderr).toBe(expected);
		expect((await lsTree(`git ls-tree ${README} ''`)).stderr).toBe(expected);
	});

	test("a path outside the repository is reported before the tree type", async () => {
		const r = await lsTree(`git ls-tree ${README} ../x`);
		expect(r.stderr).toBe("fatal: ../x: '../x' is outside repository at '/repo'\n");
		expect(r.exitCode).toBe(128);
	});

	test("the tree-ish may follow --", async () => {
		const r = await lsTree("git ls-tree -- HEAD");
		expect(r.stdout).toBe(
			lines(
				`100644 blob ${README}\tREADME.md`,
				`120000 blob ${LINK}\tlink`,
				`100755 blob ${RUN_SH}\trun.sh`,
				`040000 tree ${SRC}\tsrc`,
			),
		);
		expect(r.stderr).toBe("");
		expect(r.exitCode).toBe(0);
	});

	test("-r with the tree-ish after -- recurses", async () => {
		const r = await lsTree("git ls-tree -r -- HEAD");
		expect(r.stdout).toBe(
			lines(
				`100644 blob ${README}\tREADME.md`,
				`120000 blob ${LINK}\tlink`,
				`100755 blob ${RUN_SH}\trun.sh`,
				`100644 blob ${MATH}\tsrc/lib/math.ts`,
				`100644 blob ${MAIN}\tsrc/main.ts`,
			),
		);
		expect(r.exitCode).toBe(0);
	});

	test("paths after a tree-ish given after -- filter the listing", async () => {
		const r = await lsTree("git ls-tree -- HEAD src");
		expect(r.stdout).toBe(lines(`040000 tree ${SRC}\tsrc`));
		expect(r.exitCode).toBe(0);
	});

	test("no tree-ish prints usage and exits 129", async () => {
		for (const command of ["git ls-tree", "git ls-tree -r --"]) {
			const r = await lsTree(command);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("usage: git ls-tree [<options>] <tree-ish> [<path>...]\n");
			expect(r.exitCode).toBe(129);
		}
	});

	test("a path outside the repository is fatal", async () => {
		const r = await lsTree("git ls-tree HEAD ../../x", "/repo/src");
		expect(r.stderr).toBe("fatal: ../../x: '../../x' is outside repository at '/repo'\n");
		expect(r.exitCode).toBe(128);
	});
});
