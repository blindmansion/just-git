import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { createSandbox, jg, justBash, realGit, removeSandbox, writeToSandbox } from "./util";

const GITLINK = "1111111111111111111111111111111111111111";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\n`).join("");

// Newest first: content, typechange, gitlink, more, modes, sum, init. The
// "merged" branch merges "side", which branches from typechange, into
// content.
const CASES = [
	"show --summary HEAD~5",
	"show --summary --format=%s HEAD~5",
	"show --stat --summary HEAD~5",
	"show --shortstat --summary HEAD~5",
	"show --numstat --summary HEAD~5",
	"show -p --summary HEAD~5",
	"show --name-status --summary HEAD~5",
	"show --name-only --summary HEAD~5",
	"show --summary HEAD~4",
	"show --stat --summary HEAD~4",
	"show -p --summary --format=%s HEAD~6",
	"show --summary HEAD~3",
	"show --summary HEAD~2",
	"show --summary HEAD~1",
	"show --summary HEAD",
	"show --summary --format=%s HEAD",
	"show --summary merged",
	"show --stat --summary merged",
	"show -p --summary --format=%s merged",
	"show --stat merged",
	"show --shortstat merged",
	"show --numstat merged",
	"log --summary",
	"log --summary -3 merged",
	"log --oneline --summary",
	"log --format=%s --summary",
	"log --summary --reverse",
	"log --stat --summary -2 HEAD~4",
	"log -p --summary -1 HEAD~5",
	"log --graph --summary",
	"log --graph --oneline --summary",
	"log --name-status --summary -2 HEAD~4",
	"diff --summary HEAD~6 HEAD",
	"diff --summary HEAD~5 HEAD~3",
	"diff --stat --summary HEAD~5 HEAD~4",
	"diff --shortstat --summary HEAD~5 HEAD~4",
	"diff --numstat --summary HEAD~5 HEAD~4",
	"diff --name-status --summary HEAD~5 HEAD~4",
	"diff --summary HEAD~1 HEAD",
	"diff -U1 --summary HEAD~6 HEAD~5",
	"diff --summary -U0 HEAD~6 HEAD~4 -- n z2",
	"diff -U2 --summary HEAD~1 HEAD -- keep",
	"diff --summary HEAD~6 HEAD -- dir x",
	"diff --summary -U1 HEAD~6 HEAD -- n",
	"log --summary --oneline -- dir",
	"log --summary --oneline -- x n",
	"log --summary --format=%s -- z2",
	"log --stat --oneline -- n big2",
	"log --numstat --oneline -- z z2",
	"log --shortstat --oneline -- dir",
	"log --name-only --oneline -- dir",
	"log --name-status --oneline -- dir",
	"log -p --format=%s -- keep",
	"log -p --summary --format=%s -- z z2",
	"show --summary HEAD~3 -- dir",
	"show --summary HEAD~1 -- dir",
	"show --summary HEAD -- dir",
	"show --stat HEAD -- dir",
	"show --no-patch HEAD -- dir",
	"show HEAD -- dir",
	"show --stat --summary HEAD~5 -- n z2",
	"show -p HEAD~5 -- z z2",
	"show --name-status HEAD~1 -- x",
	"show HEAD~6 -- dir",
	"show HEAD~6 -- nothere",
	"show --stat merged -- s",
	"show --summary merged -- keep",
	"show merged -- keep",
	"show HEAD HEAD~1 -- keep",
	"show --name-only HEAD~1 HEAD -- n",
	"show --stat HEAD~5 HEAD~3 HEAD -- dir",
	"show --summary --format=%s HEAD~6 merged -- s keep",
	"show tagged -- nothere",
	"show --stat tagged -- dir",
	"diff -U-3 HEAD~1 HEAD",
	"diff --unified=-1 HEAD~1 HEAD",
];

describe("interop: --summary matches real git", () => {
	let sandbox: string;
	const git = async (cmd: string) => {
		const r = await realGit(sandbox, cmd);
		expect(r.exitCode).toBe(0);
	};

	beforeAll(async () => {
		sandbox = createSandbox();
		writeToSandbox(sandbox, "m", "m\n");
		chmodSync(join(sandbox, "m"), 0o755);
		writeToSandbox(sandbox, "z", "z\n");
		writeToSandbox(sandbox, "big", lines(20));
		writeToSandbox(sandbox, "keep", "keep\n");
		writeToSandbox(sandbox, "dir/sub/a", "a\n");
		await git("init");
		await git("add -A");
		await git("commit -m init");

		writeToSandbox(sandbox, "n", "n\n");
		await git("rm -q m");
		await git("mv z z2");
		await git("add n");
		await git("commit -m sum");

		writeToSandbox(sandbox, "big", lines(15));
		await git("mv big big2");
		chmodSync(join(sandbox, "big2"), 0o755);
		chmodSync(join(sandbox, "n"), 0o755);
		await git("add -A");
		await git("commit -m modes");

		await git("mv dir/sub/a dir/sub/b");
		symlinkSync("n", join(sandbox, "link"));
		writeToSandbox(sandbox, "sp ace", "1\n");
		writeToSandbox(sandbox, 'q"uote', "2\n");
		writeToSandbox(sandbox, "ta\tb", "3\n");
		writeToSandbox(sandbox, "é.txt", "4\n");
		await git("add -A");
		await git("commit -m more");

		await git(`update-index --add --cacheinfo 160000,${GITLINK},gm`);
		await git("commit -m gitlink");

		rmSync(join(sandbox, "n"));
		symlinkSync("keep", join(sandbox, "n"));
		mkdirSync(join(sandbox, "x/y"), { recursive: true });
		await git("mv dir/sub/b x/y/b");
		await git("add n");
		await git("commit -m typechange");

		writeToSandbox(sandbox, "keep", "keep\nmore\n");
		await git("commit -am content");

		// A merge on its own branch, so HEAD stays at "content".
		await git("checkout -q -b side HEAD~1");
		writeToSandbox(sandbox, "s", "s\n");
		await git("add s");
		await git("commit -m side");
		await git("checkout -q -");
		await git("checkout -q -b merged");
		await git("merge -q --no-ff -m merge side");
		await git("checkout -q -");
		await git("tag -a -m tagged tagged HEAD~1");
	});
	afterAll(() => removeSandbox(sandbox));

	for (const args of CASES) {
		test(`git ${args}`, async () => {
			const expected = await realGit(sandbox, args);
			const actual = await jg(justBash(sandbox), `git ${args}`);
			expect({ stdout: actual.stdout, stderr: actual.stderr, exitCode: actual.exitCode }).toEqual(
				expected,
			);
		});
	}
});
