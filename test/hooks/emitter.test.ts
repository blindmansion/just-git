import { describe, expect, test } from "bun:test";
import { HookEmitter } from "../../src/hooks";

describe("HookEmitter", () => {
	test("pre hooks short-circuit on abort", async () => {
		const emitter = new HookEmitter();
		const calls: string[] = [];
		emitter.on("pre-commit", () => {
			calls.push("first");
		});
		emitter.on("pre-commit", () => {
			calls.push("second");
			return { abort: true, message: "blocked" };
		});
		emitter.on("pre-commit", () => {
			calls.push("third");
		});

		const result = await emitter.emitPre("pre-commit", {
			index: { version: 2, entries: [] },
			treeHash: "0000000000000000000000000000000000000000",
		});
		expect(result).toEqual({ abort: true, message: "blocked" });
		expect(calls).toEqual(["first", "second"]);
	});

	test("post hooks are awaited in order", async () => {
		const emitter = new HookEmitter();
		const calls: string[] = [];
		emitter.on("post-commit", async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			calls.push("one");
		});
		emitter.on("post-commit", () => {
			calls.push("two");
		});

		await emitter.emitPost("post-commit", {
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

		expect(calls).toEqual(["one", "two"]);
	});
});
