import { describe, expect, test } from "bun:test";
import { createGit, MemoryFileSystem } from "../../src";
import { readOperationState } from "../../src/lib/operation.ts";
import { TEST_ENV } from "../fixtures";

function setup() {
	const fs = new MemoryFileSystem();
	const git = createGit({ fs, cwd: "/repo" });
	const run = (command: string) => git.exec(command, { env: TEST_ENV });
	const state = async () => {
		const ctx = await git.findRepo();
		if (!ctx) throw new Error("no repo");
		return readOperationState(ctx);
	};
	return { fs, run, state };
}

describe("readOperationState", () => {
	test("reports none in a clean repo", async () => {
		const { fs, run, state } = setup();
		await run("init");
		await fs.writeFile("/repo/README.md", "base\n");
		await run("add .");
		await run('commit -m "initial"');

		expect(await state()).toEqual({ kind: "none" });
	});

	test("detects an in-progress merge", async () => {
		const { fs, run, state } = setup();
		await run("init");
		await fs.writeFile("/repo/README.md", "base\n");
		await run("add .");
		await run('commit -m "initial"');
		await run("branch feature");

		await fs.writeFile("/repo/README.md", "main\n");
		await run("add .");
		await run('commit -m "main"');

		await run("checkout feature");
		await fs.writeFile("/repo/README.md", "feature\n");
		await run("add .");
		await run('commit -m "feature"');

		await run("checkout main");
		await run("merge feature");

		const s = await state();
		expect(s.kind).toBe("merge");
		if (s.kind === "merge") {
			expect(s.heads).toHaveLength(1);
			expect(s.heads[0]).toMatch(/^[0-9a-f]{40}$/);
		}
	});

	test("detects an in-progress cherry-pick", async () => {
		const { fs, run, state } = setup();
		await run("init");
		await fs.writeFile("/repo/README.md", "base\n");
		await run("add .");
		await run('commit -m "initial"');
		await run("branch side");

		await fs.writeFile("/repo/README.md", "main\n");
		await run("add .");
		await run('commit -m "main"');

		await run("checkout side");
		await fs.writeFile("/repo/README.md", "side\n");
		await run("add .");
		await run('commit -m "side"');

		await run("checkout main");
		await run("cherry-pick side");

		const s = await state();
		expect(s.kind).toBe("cherry-pick");
		if (s.kind === "cherry-pick") {
			expect(s.head).toMatch(/^[0-9a-f]{40}$/);
		}
	});

	test("detects an in-progress revert", async () => {
		const { fs, run, state } = setup();
		await run("init");
		await fs.writeFile("/repo/README.md", "base\n");
		await run("add .");
		await run('commit -m "initial"');

		await fs.writeFile("/repo/README.md", "v1\n");
		await run("add .");
		await run('commit -m "v1"');

		await fs.writeFile("/repo/README.md", "v2\n");
		await run("add .");
		await run('commit -m "v2"');

		// Reverting the v1 commit conflicts with the current v2 content.
		await run("revert --no-edit HEAD~1");

		const s = await state();
		expect(s.kind).toBe("revert");
		if (s.kind === "revert") {
			expect(s.head).toMatch(/^[0-9a-f]{40}$/);
		}
	});

	test("detects an in-progress rebase", async () => {
		const { fs, run, state } = setup();
		await run("init");
		await fs.writeFile("/repo/README.md", "base\n");
		await run("add .");
		await run('commit -m "initial"');
		await run("branch feature");

		await fs.writeFile("/repo/README.md", "main\n");
		await run("add .");
		await run('commit -m "main"');

		await run("checkout feature");
		await fs.writeFile("/repo/README.md", "feature\n");
		await run("add .");
		await run('commit -m "feature"');

		await run("rebase main");

		const s = await state();
		expect(s.kind).toBe("rebase");
		if (s.kind === "rebase") {
			expect(s.rebase.onto).toMatch(/^[0-9a-f]{40}$/);
		}
	});

	test("detects an in-progress am session", async () => {
		const { fs, run, state } = setup();
		await run("init");
		await fs.writeFile("/repo/f.txt", "line1\nline2\nline3\n");
		await run("add .");
		await run('commit -m "base"');
		await run("branch feature");

		await run("checkout feature");
		await fs.writeFile("/repo/f.txt", "line1\nFEATURE\nline3\n");
		await run("add .");
		await run('commit -m "feature change"');

		const patch = await run("format-patch -1 --stdout");
		await fs.writeFile("/repo/feat.patch", patch.stdout);

		await run("checkout main");
		await fs.writeFile("/repo/f.txt", "line1\nMAIN\nline3\n");
		await run("add .");
		await run('commit -m "main change"');

		// Conflicting apply leaves an in-progress am session behind.
		await run("am feat.patch");

		const s = await state();
		expect(s.kind).toBe("am");
		if (s.kind === "am") {
			expect(s.am.next).toBe(1);
			expect(s.am.last).toBe(1);
		}
	});

	test("detects an in-progress bisect", async () => {
		const { fs, run, state } = setup();
		await run("init");
		for (let i = 0; i < 4; i++) {
			await fs.writeFile("/repo/README.md", `v${i}\n`);
			await run("add .");
			await run(`commit -m "c${i}"`);
		}

		await run("bisect start");
		await run("bisect bad");
		await run("bisect good HEAD~3");

		const s = await state();
		expect(s.kind).toBe("bisect");
		if (s.kind === "bisect") {
			expect(s.bisect.termBad).toBe("bad");
			expect(s.bisect.termGood).toBe("good");
		}
	});
});
