import { describe, expect, test } from "bun:test";
import type { GitRepo, Identity } from "../../src/lib/types.ts";
import { am, formatPatchSeries } from "../../src/repo/patching.ts";
import { readCommit, resolveRef } from "../../src/repo/reading.ts";
import { createTreeAccessor } from "../../src/repo/tree-accessor.ts";
import { commit } from "../../src/repo/writing.ts";
import { MemoryStorage } from "../../src/store/memory-storage.ts";
import { createRepoStore } from "../../src/store/repo-store.ts";

const AUTHOR: Identity = {
	name: "Author",
	email: "author@example.com",
	timestamp: 1_000_000_000,
	timezone: "+0000",
};

const COMMITTER: Identity = {
	name: "Committer",
	email: "committer@example.com",
	timestamp: 1_000_000_500,
	timezone: "+0000",
};

async function freshRepo(): Promise<GitRepo> {
	return createRepoStore(new MemoryStorage()).createRepo("test");
}

async function branchFrom(repo: GitRepo, name: string, hash: string): Promise<void> {
	await repo.refStore.writeRef(`refs/heads/${name}`, { type: "direct", hash });
}

async function mailbox(
	repo: GitRepo,
	from: string,
	to: string,
): Promise<{ messages: string[]; text: string }> {
	const formatted = await formatPatchSeries(repo, { revisions: [`${from}..${to}`] });
	const messages = formatted.patches.map((patch) => patch.content);
	return { messages, text: messages.join("\n") };
}

async function fileAt(repo: GitRepo, commitHash: string, path: string): Promise<string | null> {
	const tree = (await readCommit(repo, commitHash)).tree;
	return createTreeAccessor(repo, tree).readFile(path);
}

describe("repo am: mailbox replay", () => {
	test("replays a series, preserves authors, signs off, and advances once", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "value.txt": "zero\n" },
			message: "base\n",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "source", base);
		const first = await commit(repo, {
			files: { "value.txt": "one\n" },
			message: "first\n",
			author: AUTHOR,
			branch: "source",
		});
		const second = await commit(repo, {
			files: { "extra.txt": "two\n" },
			message: "second\n",
			author: AUTHOR,
			branch: "source",
		});
		await branchFrom(repo, "target", base);
		const series = await mailbox(repo, base, second);

		const result = await am(repo, {
			mbox: series.text,
			onto: base,
			committer: COMMITTER,
			branch: "target",
			expectedOldHash: base,
			signoff: true,
		});

		expect(result.status).toBe("applied");
		if (result.status !== "applied") throw new Error("unreachable");
		expect(result.commits).toHaveLength(2);
		expect(await resolveRef(repo, "refs/heads/target")).toBe(result.head);
		expect(await fileAt(repo, result.head, "value.txt")).toBe("one\n");
		expect(await fileAt(repo, result.head, "extra.txt")).toBe("two\n");

		const c1 = await readCommit(repo, result.commits[0] as string);
		const c2 = await readCommit(repo, result.commits[1] as string);
		expect(c1.parents).toEqual([base]);
		expect(c2.parents).toEqual([result.commits[0]]);
		expect(c1.author).toEqual((await readCommit(repo, first)).author);
		expect(c1.committer).toEqual(COMMITTER);
		expect(c1.message).toContain("Signed-off-by: Committer <committer@example.com>");
	});

	test("omitting branch leaves refs unchanged", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "a.txt": "a\n" },
			message: "base\n",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "source", base);
		const source = await commit(repo, {
			files: { "a.txt": "b\n" },
			message: "change\n",
			author: AUTHOR,
			branch: "source",
		});
		const series = await mailbox(repo, base, source);

		const result = await am(repo, { mbox: series.messages, onto: base, committer: COMMITTER });
		expect(result.status).toBe("applied");
		expect(await resolveRef(repo, "refs/heads/main")).toBe(base);
	});
});

describe("repo am: rejected message repair", () => {
	test("retains prior commits and resumes with a replacement message", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "value.txt": "zero\n" },
			message: "base\n",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "source", base);
		await commit(repo, {
			files: { "value.txt": "one\n" },
			message: "first\n",
			author: AUTHOR,
			branch: "source",
		});
		const source = await commit(repo, {
			files: { "value.txt": "two\n" },
			message: "second\n",
			author: AUTHOR,
			branch: "source",
		});
		const series = await mailbox(repo, base, source);
		const broken = (series.messages[1] as string).replace("-one\n", "-not-one\n");

		const stopped = await am(repo, {
			mbox: [series.messages[0] as string, broken],
			onto: base,
			committer: COMMITTER,
		});
		expect(stopped.status).toBe("rejected");
		if (stopped.status !== "rejected") throw new Error("unreachable");
		expect(stopped.failedIndex).toBe(1);
		expect(stopped.applied).toHaveLength(1);
		expect(stopped.rejection.kind).toBe("apply-rejected");

		const serialized = JSON.parse(JSON.stringify(stopped.continuation));
		const done = await am(repo, {
			continue: serialized,
			replacementMessage: series.messages[1] as string,
		});
		expect(done.status).toBe("applied");
		if (done.status !== "applied") throw new Error("unreachable");
		expect(done.commits).toHaveLength(2);
		expect(await fileAt(repo, done.head, "value.txt")).toBe("two\n");
	});

	test("returns typed empty and parse-error rejections", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "a.txt": "a\n" },
			message: "base\n",
			author: AUTHOR,
			branch: "main",
		});

		const empty = await am(repo, {
			mbox: "From: A <a@example.com>\nSubject: [PATCH] empty\n\nmessage only\n",
			onto: base,
			committer: COMMITTER,
		});
		expect(empty.status).toBe("rejected");
		if (empty.status !== "rejected") throw new Error("unreachable");
		expect(empty.rejection.kind).toBe("empty-patch");

		const malformed =
			"From: A <a@example.com>\nSubject: [PATCH] bad\n\n" +
			"diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -oops +1 @@\n-a\n+b\n";
		const parsed = await am(repo, { mbox: malformed, onto: base, committer: COMMITTER });
		expect(parsed.status).toBe("rejected");
		if (parsed.status !== "rejected") throw new Error("unreachable");
		expect(parsed.rejection.kind).toBe("parse-error");
	});

	test("distinguishes unavailable and hand-edited three-way bases", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "a.txt": "a\nb\n" },
			message: "base\n",
			author: AUTHOR,
			branch: "main",
		});
		const target = await commit(repo, {
			files: { "a.txt": "ours\nb\n" },
			message: "target\n",
			author: AUTHOR,
			branch: "main",
		});
		const noOid =
			"From: A <a@example.com>\nSubject: [PATCH] no oid\n\n" +
			"diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-a\n+patched\n b\n";
		const unavailable = await am(repo, {
			mbox: noOid,
			onto: target,
			committer: COMMITTER,
			threeWay: true,
		});
		expect(unavailable.status).toBe("rejected");
		if (unavailable.status !== "rejected") throw new Error("unreachable");
		expect(unavailable.rejection.kind).toBe("three-way-unavailable");

		await branchFrom(repo, "source", base);
		const source = await commit(repo, {
			files: { "a.txt": "changed\nb\n" },
			message: "change\n",
			author: AUTHOR,
			branch: "source",
		});
		const valid = (await mailbox(repo, base, source)).messages[0] as string;
		const handEdited = valid.replace(" b\n", " impossible-context\n");
		const failed = await am(repo, {
			mbox: handEdited,
			onto: target,
			committer: COMMITTER,
			threeWay: true,
		});
		expect(failed.status).toBe("rejected");
		if (failed.status !== "rejected") throw new Error("unreachable");
		expect(failed.rejection.kind).toBe("three-way-apply-failed");
	});
});

describe("repo am: three-way continuation", () => {
	test("falls back to a clean tree merge when patch context drifted", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "lines.txt": "a\nb\nc\nd\ne\n" },
			message: "base\n",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "source", base);
		const source = await commit(repo, {
			files: { "lines.txt": "a\nB\nc\nd\ne\n" },
			message: "source\n",
			author: AUTHOR,
			branch: "source",
		});
		await branchFrom(repo, "target", base);
		const target = await commit(repo, {
			files: { "lines.txt": "a\nb\nc\nD\ne\n" },
			message: "target\n",
			author: AUTHOR,
			branch: "target",
		});
		const series = await mailbox(repo, base, source);

		const result = await am(repo, {
			mbox: series.text,
			onto: target,
			committer: COMMITTER,
			threeWay: true,
		});
		expect(result.status).toBe("applied");
		if (result.status !== "applied") throw new Error("unreachable");
		expect(await fileAt(repo, result.head, "lines.txt")).toBe("a\nB\nc\nD\ne\n");
	});

	test("supports partial conflict resolutions and skips already-applied patches", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "x.txt": "base\n", "y.txt": "base\n" },
			message: "base\n",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "source", base);
		const source = await commit(repo, {
			files: { "x.txt": "theirs\n", "y.txt": "theirs\n" },
			message: "source\n",
			author: AUTHOR,
			branch: "source",
		});
		await branchFrom(repo, "target", base);
		const target = await commit(repo, {
			files: { "x.txt": "ours\n", "y.txt": "ours\n" },
			message: "target\n",
			author: AUTHOR,
			branch: "target",
		});
		const series = await mailbox(repo, base, source);

		const stopped = await am(repo, {
			mbox: series.text,
			onto: target,
			committer: COMMITTER,
			threeWay: true,
		});
		expect(stopped.status).toBe("conflicts");
		if (stopped.status !== "conflicts") throw new Error("unreachable");
		expect(stopped.conflicts.map((c) => c.path)).toEqual(["x.txt", "y.txt"]);

		const partial = await am(repo, {
			continue: stopped.continuation,
			resolutions: { "x.txt": "theirs" },
		});
		expect(partial.status).toBe("conflicts");
		if (partial.status !== "conflicts") throw new Error("unreachable");
		expect(partial.unresolved).toEqual(["y.txt"]);

		const done = await am(repo, {
			continue: partial.continuation,
			resolutions: { "x.txt": "theirs", "y.txt": "ours" },
		});
		expect(done.status).toBe("applied");
		if (done.status !== "applied") throw new Error("unreachable");
		expect(await fileAt(repo, done.head, "x.txt")).toBe("theirs\n");
		expect(await fileAt(repo, done.head, "y.txt")).toBe("ours\n");

		const skipped = await am(repo, {
			mbox: series.text,
			onto: source,
			committer: COMMITTER,
			threeWay: true,
		});
		expect(skipped).toEqual({ status: "applied", head: source, commits: [] });
	});
});

describe("repo am: branch CAS", () => {
	test("rejects a stale guard without changing branch or HEAD", async () => {
		const repo = await freshRepo();
		const base = await commit(repo, {
			files: { "a.txt": "a\n" },
			message: "base\n",
			author: AUTHOR,
			branch: "main",
		});
		await branchFrom(repo, "source", base);
		const source = await commit(repo, {
			files: { "a.txt": "b\n" },
			message: "change\n",
			author: AUTHOR,
			branch: "source",
		});
		await branchFrom(repo, "target", base);
		const series = await mailbox(repo, base, source);
		const headBefore = await repo.refStore.readRef("HEAD");

		await expect(
			am(repo, {
				mbox: series.text,
				onto: base,
				committer: COMMITTER,
				branch: "target",
				expectedOldHash: "0".repeat(40),
			}),
		).rejects.toThrow("CAS failed");
		expect(await resolveRef(repo, "refs/heads/target")).toBe(base);
		expect(await repo.refStore.readRef("HEAD")).toEqual(headBefore);
	});
});
