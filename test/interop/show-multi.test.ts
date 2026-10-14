import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSandbox, jg, justBash, realGit, removeSandbox, writeToSandbox } from "./util";

// Commits: init, addn, content (HEAD). "v1" is an annotated tag of addn,
// "vtree" an annotated tag of HEAD's tree and "light" a lightweight tag.
const CASES = [
	"show HEAD~1 HEAD",
	"show HEAD HEAD~1 HEAD~2",
	"show --no-patch HEAD HEAD~1",
	"show --stat HEAD HEAD~1",
	"show --name-status HEAD~2 HEAD",
	"show --format=%s HEAD HEAD~1",
	"show --format=%s --no-patch HEAD HEAD~1",
	"show --pretty=format:%s HEAD HEAD~1",
	"show --pretty=format:%s --no-patch HEAD HEAD~1",
	"show --pretty=oneline HEAD HEAD~1",
	"show --pretty=oneline --stat HEAD HEAD^{tree}",
	"show --pretty=short --no-patch HEAD HEAD~1",
	"show --format= HEAD HEAD~1",
	"show --no-patch HEAD HEAD",
	"show --no-patch HEAD HEAD~1 HEAD",
	"show HEAD light",
	// Blobs, trees and rev:path.
	"show HEAD:keep HEAD~1:keep",
	"show HEAD:keep HEAD",
	"show HEAD HEAD:keep",
	"show HEAD^{tree}",
	"show HEAD^{tree} HEAD:keep",
	"show HEAD:keep HEAD^{tree}",
	"show HEAD:d HEAD:keep",
	"show HEAD HEAD:d",
	"show --no-patch HEAD^{tree} HEAD^{tree}",
	// Tags.
	"show v1",
	"show v1 HEAD",
	"show HEAD v1",
	"show HEAD:keep v1",
	"show v1 HEAD:keep HEAD^{tree} v1",
	"show --no-patch HEAD~1 v1",
	"show --no-patch v1 v1",
	"show vtree",
	"show HEAD vtree",
	"show --pretty=oneline --no-patch v1",
	"show --pretty=short --no-patch v1",
	"show --pretty=full --no-patch v1",
	"show --pretty=fuller --no-patch v1",
	"show --pretty=raw --no-patch v1",
	"show --pretty=format:%s --no-patch v1",
	"show --format=%s --no-patch HEAD v1 HEAD^{tree}",
	// Pathspecs.
	"show HEAD HEAD~1 -- keep",
	"show HEAD~1 HEAD HEAD~1 -- nothere",
	"show --name-only HEAD HEAD~1 -- n keep",
	"show v1 HEAD -- keep",
	"show HEAD keep",
	"show HEAD keep z",
	"show keep",
	// Errors stop the command before anything is shown.
	"show HEAD bogus HEAD~1",
	"show HEAD bogus -- keep",
	"show HEAD keep nope",
	"show HEAD:keep HEAD:nope HEAD",
	"show HEAD HEAD:z2",
	"show HEAD:/keep",
	"show 0123456789012345678901234567890123456789",
	"show bogus",
];

describe("interop: show with multiple objects matches real git", () => {
	let sandbox: string;
	const git = async (cmd: string) => {
		const r = await realGit(sandbox, cmd);
		expect(r.exitCode).toBe(0);
	};

	beforeAll(async () => {
		sandbox = createSandbox();
		writeToSandbox(sandbox, "keep", "keep\n");
		writeToSandbox(sandbox, "z", "z\n");
		writeToSandbox(sandbox, "d/a", "a\n");
		await git("init");
		await git("add -A");
		await git("commit -m init");

		writeToSandbox(sandbox, "n", "n\n");
		await git("add n");
		await git("commit -m addn");

		writeToSandbox(sandbox, "keep", "keep\nmore\n");
		await git("commit -am content");

		await git("tag -a -m tagmsg v1 HEAD~1");
		await git("tag -a -m treetag vtree HEAD^{tree}");
		await git("tag light HEAD");
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
