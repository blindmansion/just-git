import { describe, expect, test } from "bun:test";
import { EMPTY_REPO } from "../fixtures";
import { createHookBash } from "./helpers";

describe("beforeCommand / afterCommand hooks", () => {
	test("beforeCommand receives command metadata including cwd/env", async () => {
		let seenCwd = "";
		let seenEnv = "";
		const { bash } = createHookBash(
			{ files: EMPTY_REPO },
			{
				hooks: {
					beforeCommand: (event) => {
						seenCwd = event.cwd;
						seenEnv = event.env.get("GIT_AUTHOR_EMAIL") ?? "";
					},
				},
			},
		);
		await bash.exec("git init");
		expect(seenCwd).toBe("/repo");
		expect(seenEnv).toBe("test@test.com");
	});

	test("beforeCommand receives fs for file inspection", async () => {
		let content = "";
		const { bash } = createHookBash(
			{ files: { ...EMPTY_REPO, "/repo/hello.txt": "world" } },
			{
				hooks: {
					beforeCommand: async (event) => {
						if (event.command === "add") {
							content = await event.fs.readFile("/repo/hello.txt");
						}
					},
				},
			},
		);
		await bash.exec("git init");
		await bash.exec("git add .");
		expect(content).toBe("world");
	});

	test("beforeCommand can reject a command", async () => {
		const { bash } = createHookBash(
			{ files: EMPTY_REPO },
			{
				hooks: {
					beforeCommand: (event) => {
						if (event.command === "init") {
							return { reject: true, message: "blocked by policy" };
						}
					},
				},
			},
		);
		const result = await bash.exec("git init");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("blocked by policy");
	});

	test("afterCommand receives command result", async () => {
		let seenCommand = "";
		let seenExitCode = -1;
		const { bash } = createHookBash(
			{ files: EMPTY_REPO },
			{
				hooks: {
					afterCommand: (event) => {
						seenCommand = event.command;
						seenExitCode = event.result.exitCode;
					},
				},
			},
		);
		await bash.exec("git init");
		expect(seenCommand).toBe("init");
		expect(seenExitCode).toBe(0);
	});
});
