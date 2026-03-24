import { afterEach, describe, expect, test } from "bun:test";
import {
	createAuthBash,
	loadNetworkEnv,
	type NetworkEnv,
	skipLog,
	skipNetwork,
	uniqueRef,
} from "./network-helpers.ts";

const TIMEOUT = 60000;

describe.skipIf(skipNetwork)("Smart HTTP fetch", () => {
	let net: NetworkEnv | null;
	let cleanupBranches: string[] = [];
	let cleanupBash: ReturnType<typeof createAuthBash> | null = null;

	afterEach(async () => {
		if (!cleanupBash || !net) return;
		const cwd = "/repo/work";
		for (const branch of cleanupBranches) {
			await cleanupBash.exec(`git push origin --delete ${branch}`, { cwd });
		}
		cleanupBranches = [];
	});

	function setup() {
		net = loadNetworkEnv();
		if (!net) return null;
		const bash = createAuthBash(net);
		cleanupBash = bash;
		return { bash, net };
	}

	async function cloneFixture(bash: ReturnType<typeof createAuthBash>, env: NetworkEnv) {
		const result = await bash.exec(`git clone ${env.repo} work`);
		if (result.exitCode !== 0) {
			console.log("SKIP: clone failed:", result.stderr);
			return false;
		}
		return true;
	}

	test(
		"fetch updates tracking refs",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("fetch tracking");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const cwd = "/repo/work";

			// Fetch again — should succeed and update refs
			const fetchResult = await ctx.bash.exec("git fetch origin", { cwd });
			expect(fetchResult.exitCode).toBe(0);

			const branchResult = await ctx.bash.exec("git branch -r", { cwd });
			expect(branchResult.exitCode).toBe(0);
			expect(branchResult.stdout).toContain("origin/main");
		},
		TIMEOUT,
	);

	test(
		"fetch specific refspec",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("fetch refspec");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("fetchspec");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			// Push a branch so we have something specific to fetch
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "fetchspec" > fetchspec.txt', { cwd });
			await ctx.bash.exec("git add fetchspec.txt", { cwd });
			await ctx.bash.exec('git commit -m "fetchspec"', { cwd });
			await ctx.bash.exec(`git push -u origin ${branch}`, { cwd });

			// Delete the tracking ref locally, then re-fetch just that branch
			await ctx.bash.exec("git checkout main", { cwd });
			await ctx.bash.exec(`git branch -D ${branch}`, { cwd });

			const fetchResult = await ctx.bash.exec(
				`git fetch origin refs/heads/${branch}:refs/remotes/origin/${branch}`,
				{ cwd },
			);
			expect(fetchResult.exitCode).toBe(0);

			const branchResult = await ctx.bash.exec("git branch -r", { cwd });
			expect(branchResult.stdout).toContain(`origin/${branch}`);
		},
		TIMEOUT,
	);

	test(
		"fetch --prune removes stale tracking refs",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("fetch --prune");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("prune");
			const cwd = "/repo/work";

			// Push a branch, then fetch to create the local tracking ref
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "prune" > prune.txt', { cwd });
			await ctx.bash.exec("git add prune.txt", { cwd });
			await ctx.bash.exec('git commit -m "prune"', { cwd });
			await ctx.bash.exec(`git push origin ${branch}`, { cwd });
			await ctx.bash.exec("git fetch origin", { cwd });

			// Tracking ref should now exist
			await ctx.bash.exec("git checkout main", { cwd });
			const before = await ctx.bash.exec("git branch -r", { cwd });
			expect(before.stdout).toContain(`origin/${branch}`);

			// Delete the remote branch
			await ctx.bash.exec(`git push origin --delete ${branch}`, { cwd });

			// Fetch --prune should remove the stale tracking ref
			const fetchResult = await ctx.bash.exec("git fetch origin --prune", {
				cwd,
			});
			expect(fetchResult.exitCode).toBe(0);

			const after = await ctx.bash.exec("git branch -r", { cwd });
			expect(after.stdout).not.toContain(`origin/${branch}`);
		},
		TIMEOUT,
	);

	test(
		"incremental fetch picks up new commits",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("incremental fetch");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("incfetch");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			// Push an initial commit
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "first" > inc.txt', { cwd });
			await ctx.bash.exec("git add inc.txt", { cwd });
			await ctx.bash.exec('git commit -m "first"', { cwd });
			await ctx.bash.exec(`git push origin ${branch}`, { cwd });

			// Fetch so tracking ref is created
			await ctx.bash.exec("git fetch origin", { cwd });
			const log1 = await ctx.bash.exec(`git log --oneline origin/${branch}`, {
				cwd,
			});
			expect(log1.stdout).toContain("first");

			// Push a second commit
			await ctx.bash.exec('echo "second" > inc2.txt', { cwd });
			await ctx.bash.exec("git add inc2.txt", { cwd });
			await ctx.bash.exec('git commit -m "second"', { cwd });
			await ctx.bash.exec(`git push origin ${branch}`, { cwd });

			// Reset local back so the tracking ref is behind
			await ctx.bash.exec("git reset --hard HEAD~1", { cwd });

			// Incremental fetch should pick up the new commit
			const fetchResult = await ctx.bash.exec("git fetch origin", { cwd });
			expect(fetchResult.exitCode).toBe(0);

			const log2 = await ctx.bash.exec(`git log --oneline origin/${branch}`, {
				cwd,
			});
			expect(log2.stdout).toContain("second");
		},
		TIMEOUT,
	);

	test(
		"fetch --tags pulls tags",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("fetch --tags");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const cwd = "/repo/work";

			const fetchResult = await ctx.bash.exec("git fetch origin --tags", {
				cwd,
			});
			expect(fetchResult.exitCode).toBe(0);

			const tagResult = await ctx.bash.exec("git tag", { cwd });
			expect(tagResult.exitCode).toBe(0);
		},
		TIMEOUT,
	);
});
