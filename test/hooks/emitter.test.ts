import { describe, expect, test } from "bun:test";
import { composeGitHooks, isRejection, type GitHooks } from "../../src/hooks";
import type { GitRepo } from "../../src/lib/types";

const dummyRepo = {} as GitRepo;

describe("isRejection", () => {
	test("returns true for rejection objects", () => {
		expect(isRejection({ reject: true })).toBe(true);
		expect(isRejection({ reject: true, message: "nope" })).toBe(true);
	});

	test("returns false for non-rejections", () => {
		expect(isRejection(undefined)).toBe(false);
		expect(isRejection(null)).toBe(false);
		expect(isRejection({})).toBe(false);
		expect(isRejection({ reject: false })).toBe(false);
		expect(isRejection("string")).toBe(false);
	});
});

describe("composeGitHooks", () => {
	test("pre hooks short-circuit on first rejection", async () => {
		const calls: string[] = [];
		const hooks = composeGitHooks(
			{
				preCommit: () => {
					calls.push("first");
				},
			},
			{
				preCommit: () => {
					calls.push("second");
					return { reject: true, message: "blocked" };
				},
			},
			{
				preCommit: () => {
					calls.push("third");
				},
			},
		);

		const result = await hooks.preCommit!({
			repo: dummyRepo,
			index: { version: 2, entries: [] },
			treeHash: "0000000000000000000000000000000000000000",
		});
		expect(result).toEqual({ reject: true, message: "blocked" });
		expect(calls).toEqual(["first", "second"]);
	});

	test("post hooks are called in order and individually caught", async () => {
		const calls: string[] = [];
		const hooks = composeGitHooks(
			{
				postCommit: async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					calls.push("one");
				},
			},
			{
				postCommit: () => {
					throw new Error("boom");
				},
			},
			{
				postCommit: () => {
					calls.push("three");
				},
			},
		);

		await hooks.postCommit!({
			repo: dummyRepo,
			hash: "1111111111111111111111111111111111111111",
			message: "msg\n",
			branch: "main",
			parents: [],
			author: {
				name: "T",
				email: "t@test.com",
				timestamp: 1,
				timezone: "+0000",
			},
		});

		expect(calls).toEqual(["one", "three"]);
	});

	test("low-level events are individually caught", () => {
		const hashes: string[] = [];
		const hooks = composeGitHooks(
			{
				onObjectWrite: (e) => {
					hashes.push(e.hash);
				},
			},
			{
				onObjectWrite: () => {
					throw new Error("fail");
				},
			},
			{
				onObjectWrite: (e) => {
					hashes.push(`dup:${e.hash}`);
				},
			},
		);

		hooks.onObjectWrite!({
			repo: dummyRepo,
			type: "blob",
			hash: "abcd",
		});
		expect(hashes).toEqual(["abcd", "dup:abcd"]);
	});

	test("mutable message hooks chain the message through", async () => {
		const hooks = composeGitHooks(
			{
				commitMsg: (e) => {
					e.message = e.message.toUpperCase();
				},
			},
			{
				commitMsg: (e) => {
					e.message += " EXTRA";
				},
			},
		);

		const event = { repo: dummyRepo, message: "hello" };
		await hooks.commitMsg!(event);
		expect(event.message).toBe("HELLO EXTRA");
	});

	test("returns empty hooks for no inputs", () => {
		const hooks = composeGitHooks();
		expect(hooks).toEqual({});
	});

	test("returns single set unchanged", () => {
		const single: GitHooks = { preCommit: () => {} };
		const hooks = composeGitHooks(single);
		expect(hooks).toBe(single);
	});

	test("skips undefined entries", () => {
		const single: GitHooks = { preCommit: () => {} };
		const hooks = composeGitHooks(undefined, single, undefined);
		expect(hooks).toBe(single);
	});
});
