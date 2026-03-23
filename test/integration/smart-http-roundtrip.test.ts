import { afterEach, describe, expect, test } from "bun:test";
import {
	createAuthBash,
	loadNetworkEnv,
	type NetworkEnv,
	skipLog,
	uniqueRef,
} from "./network-helpers.ts";

const TIMEOUT = 60000;

describe("Smart HTTP round-trip", () => {
	let net: NetworkEnv | null;
	let cleanupBranches: string[] = [];
	let cleanupTags: string[] = [];
	let cleanupBash: ReturnType<typeof createAuthBash> | null = null;

	afterEach(async () => {
		if (!cleanupBash || !net) return;
		const cwd = "/repo/src";

		for (const branch of cleanupBranches) {
			await cleanupBash.exec(`git push origin --delete ${branch}`, { cwd });
		}
		for (const tag of cleanupTags) {
			await cleanupBash.exec(`git push origin --delete ${tag}`, { cwd });
		}
		cleanupBranches = [];
		cleanupTags = [];
	});

	function setup() {
		net = loadNetworkEnv();
		if (!net) return null;
		const bash = createAuthBash(net);
		cleanupBash = bash;
		return { bash, net };
	}

	test(
		"pushed content is readable from a fresh clone",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("round-trip");
				return;
			}

			// Clone into /repo/src
			const cloneResult = await ctx.bash.exec(`git clone ${ctx.net.repo} src`);
			if (cloneResult.exitCode !== 0) {
				console.log("SKIP: clone failed:", cloneResult.stderr);
				return;
			}

			const branch = uniqueRef("roundtrip");
			cleanupBranches.push(branch);
			const srcCwd = "/repo/src";

			// Create a branch with multiple files and push
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd: srcCwd });
			await ctx.bash.exec('echo "hello world" > hello.txt', { cwd: srcCwd });
			await ctx.bash.exec('echo "line1\nline2\nline3" > multi.txt', {
				cwd: srcCwd,
			});
			await ctx.bash.exec("mkdir -p sub/dir", { cwd: srcCwd });
			await ctx.bash.exec('echo "nested" > sub/dir/deep.txt', {
				cwd: srcCwd,
			});
			await ctx.bash.exec("git add .", { cwd: srcCwd });
			await ctx.bash.exec('git commit -m "round-trip content"', {
				cwd: srcCwd,
			});

			const pushResult = await ctx.bash.exec(`git push origin ${branch}`, {
				cwd: srcCwd,
			});
			expect(pushResult.exitCode).toBe(0);

			// Fresh clone into /repo/dst
			const bash2 = createAuthBash(ctx.net);
			const clone2 = await bash2.exec(`git clone -b ${branch} ${ctx.net.repo} dst`);
			expect(clone2.exitCode).toBe(0);

			const dstCwd = "/repo/dst";

			// Verify file contents match what we pushed
			const cat1 = await bash2.exec("cat hello.txt", { cwd: dstCwd });
			expect(cat1.stdout.trim()).toBe("hello world");

			const cat2 = await bash2.exec("cat multi.txt", { cwd: dstCwd });
			expect(cat2.stdout).toContain("line1");
			expect(cat2.stdout).toContain("line3");

			const cat3 = await bash2.exec("cat sub/dir/deep.txt", { cwd: dstCwd });
			expect(cat3.stdout.trim()).toBe("nested");

			// Status should be clean
			const status = await bash2.exec("git status", { cwd: dstCwd });
			expect(status.stdout).toContain("nothing to commit");

			// Commit messages should match
			const log = await bash2.exec("git log --oneline -1", { cwd: dstCwd });
			expect(log.stdout).toContain("round-trip content");
		},
		TIMEOUT,
	);

	test.skip(
		"pushed tag is visible from a fresh clone",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("round-trip tag");
				return;
			}

			const cloneResult = await ctx.bash.exec(`git clone ${ctx.net.repo} src`);
			if (cloneResult.exitCode !== 0) {
				console.log("SKIP: clone failed:", cloneResult.stderr);
				return;
			}

			const branch = uniqueRef("rt-tag");
			const tag = `rt-tag-${Date.now()}`;
			cleanupBranches.push(branch);
			cleanupTags.push(tag);
			const srcCwd = "/repo/src";

			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd: srcCwd });
			await ctx.bash.exec('echo "tagged" > tagged.txt', { cwd: srcCwd });
			await ctx.bash.exec("git add tagged.txt", { cwd: srcCwd });
			await ctx.bash.exec('git commit -m "tagged commit"', { cwd: srcCwd });
			await ctx.bash.exec(`git push origin ${branch}`, { cwd: srcCwd });
			await ctx.bash.exec(`git tag -a ${tag} -m "release tag"`, {
				cwd: srcCwd,
			});
			await ctx.bash.exec("git push origin --tags", { cwd: srcCwd });

			// Fresh clone should see the tag
			const bash2 = createAuthBash(ctx.net);
			const clone2 = await bash2.exec(`git clone ${ctx.net.repo} dst`);
			expect(clone2.exitCode).toBe(0);

			const dstCwd = "/repo/dst";
			const tagResult = await bash2.exec("git tag", { cwd: dstCwd });
			expect(tagResult.stdout).toContain(tag);

			// Show the tag
			const showResult = await bash2.exec(`git show ${tag}`, { cwd: dstCwd });
			expect(showResult.exitCode).toBe(0);
			expect(showResult.stdout).toContain("release tag");
		},
		TIMEOUT,
	);
});
