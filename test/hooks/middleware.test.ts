import { describe, expect, test } from "bun:test";
import { EMPTY_REPO } from "../fixtures";
import { createHookBash } from "./helpers";

describe("middleware", () => {
	test("middleware receives command metadata including cwd/env", async () => {
		const { bash, git } = createHookBash({ files: EMPTY_REPO });
		let seenCwd = "";
		let seenEnv = "";
		git.use((event, next) => {
			seenCwd = event.cwd;
			seenEnv = event.env.get("GIT_AUTHOR_EMAIL") ?? "";
			return next();
		});
		await bash.exec("git init");
		expect(seenCwd).toBe("/repo");
		expect(seenEnv).toBe("test@test.com");
	});

	test("middleware receives full execution context (fs, stdin, exec)", async () => {
		const { bash, git } = createHookBash({ files: EMPTY_REPO });
		let hasFs = false;
		let hasExec = false;
		let seenStdin = "";
		git.use((event, next) => {
			hasFs = typeof event.fs?.readFile === "function";
			hasExec = typeof event.exec === "function";
			seenStdin = event.stdin;
			return next();
		});
		await bash.exec("git init");
		expect(hasFs).toBe(true);
		expect(hasExec).toBe(true);
		expect(seenStdin).toBe("");
	});

	test("middleware can read files via fs", async () => {
		const { bash, git } = createHookBash({
			files: { ...EMPTY_REPO, "/repo/hello.txt": "world" },
		});
		let content = "";
		git.use(async (event, next) => {
			if (event.command === "add") {
				content = await event.fs.readFile("/repo/hello.txt");
			}
			return next();
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		expect(content).toBe("world");
	});

	test("middlewares compose in registration order", async () => {
		const { bash, git } = createHookBash({ files: EMPTY_REPO });
		const order: number[] = [];
		git.use(async (_event, next) => {
			order.push(1);
			const result = await next();
			order.push(4);
			return result;
		});
		git.use(async (_event, next) => {
			order.push(2);
			const result = await next();
			order.push(3);
			return result;
		});

		await bash.exec("git init");
		expect(order).toEqual([1, 2, 3, 4]);
	});
});
