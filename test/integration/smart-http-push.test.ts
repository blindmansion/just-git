import { afterEach, describe, expect, test } from "bun:test";
import {
	createAuthBash,
	loadNetworkEnv,
	type NetworkEnv,
	skipLog,
	uniqueRef,
} from "./network-helpers.ts";

const TIMEOUT = 60000;

describe.skip("Smart HTTP push", () => {
	let net: NetworkEnv | null;
	let cleanupBranches: string[] = [];
	let cleanupTags: string[] = [];
	let cleanupBash: ReturnType<typeof createAuthBash> | null = null;

	afterEach(async () => {
		if (!cleanupBash || !net) return;
		const cwd = "/repo/work";

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

	async function cloneFixture(bash: ReturnType<typeof createAuthBash>, env: NetworkEnv) {
		const result = await bash.exec(`git clone ${env.repo} work`);
		if (result.exitCode !== 0) {
			console.log("SKIP: clone failed:", result.stderr);
			return false;
		}
		return true;
	}

	test(
		"push a new branch",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("push new branch");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("push");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "push-test" > push-test.txt', { cwd });
			await ctx.bash.exec("git add push-test.txt", { cwd });
			await ctx.bash.exec('git commit -m "test push"', { cwd });

			const pushResult = await ctx.bash.exec(`git push -u origin ${branch}`, {
				cwd,
			});
			expect(pushResult.exitCode).toBe(0);
		},
		TIMEOUT,
	);

	test(
		"push rejected without --force on diverged branch",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("push rejected");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("reject");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			// Push an initial commit to the branch
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "first" > diverge.txt', { cwd });
			await ctx.bash.exec("git add diverge.txt", { cwd });
			await ctx.bash.exec('git commit -m "first"', { cwd });
			const push1 = await ctx.bash.exec(`git push -u origin ${branch}`, {
				cwd,
			});
			expect(push1.exitCode).toBe(0);

			// Reset local, make a divergent commit
			await ctx.bash.exec("git reset --hard HEAD~1", { cwd });
			await ctx.bash.exec('echo "diverged" > diverge.txt', { cwd });
			await ctx.bash.exec("git add diverge.txt", { cwd });
			await ctx.bash.exec('git commit -m "diverged"', { cwd });

			// Non-force push should fail
			const push2 = await ctx.bash.exec(`git push origin ${branch}`, { cwd });
			expect(push2.exitCode).not.toBe(0);
		},
		TIMEOUT,
	);

	test(
		"force push succeeds on diverged branch",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("force push");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("force");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "first" > force.txt', { cwd });
			await ctx.bash.exec("git add force.txt", { cwd });
			await ctx.bash.exec('git commit -m "first"', { cwd });
			await ctx.bash.exec(`git push -u origin ${branch}`, { cwd });

			await ctx.bash.exec("git reset --hard HEAD~1", { cwd });
			await ctx.bash.exec('echo "forced" > force.txt', { cwd });
			await ctx.bash.exec("git add force.txt", { cwd });
			await ctx.bash.exec('git commit -m "forced"', { cwd });

			const pushResult = await ctx.bash.exec(`git push --force origin ${branch}`, { cwd });
			expect(pushResult.exitCode).toBe(0);
		},
		TIMEOUT,
	);

	test(
		"push --delete removes remote branch",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("push --delete");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("delete");
			const cwd = "/repo/work";

			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "del" > del.txt', { cwd });
			await ctx.bash.exec("git add del.txt", { cwd });
			await ctx.bash.exec('git commit -m "to delete"', { cwd });
			await ctx.bash.exec(`git push -u origin ${branch}`, { cwd });

			const delResult = await ctx.bash.exec(`git push origin --delete ${branch}`, { cwd });
			expect(delResult.exitCode).toBe(0);

			// Fetch and verify the branch is gone
			await ctx.bash.exec("git fetch origin --prune", { cwd });
			const branchResult = await ctx.bash.exec("git branch -r", { cwd });
			expect(branchResult.stdout).not.toContain(branch);
		},
		TIMEOUT,
	);

	test(
		"push --all pushes multiple branches",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("push --all");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch1 = uniqueRef("all-a");
			const branch2 = uniqueRef("all-b");
			cleanupBranches.push(branch1, branch2);
			const cwd = "/repo/work";

			// Create two branches with commits
			await ctx.bash.exec(`git checkout -b ${branch1}`, { cwd });
			await ctx.bash.exec('echo "branch-a" > a.txt', { cwd });
			await ctx.bash.exec("git add a.txt", { cwd });
			await ctx.bash.exec('git commit -m "branch a"', { cwd });

			await ctx.bash.exec("git checkout main", { cwd });
			await ctx.bash.exec(`git checkout -b ${branch2}`, { cwd });
			await ctx.bash.exec('echo "branch-b" > b.txt', { cwd });
			await ctx.bash.exec("git add b.txt", { cwd });
			await ctx.bash.exec('git commit -m "branch b"', { cwd });

			// Push all at once
			const pushResult = await ctx.bash.exec("git push --all origin", { cwd });
			expect(pushResult.exitCode).toBe(0);

			// Fetch and verify both branches exist on remote
			await ctx.bash.exec("git fetch origin", { cwd });
			const branchResult = await ctx.bash.exec("git branch -r", { cwd });
			expect(branchResult.stdout).toContain(`origin/${branch1}`);
			expect(branchResult.stdout).toContain(`origin/${branch2}`);
		},
		TIMEOUT,
	);

	test(
		"push --tags pushes annotated tags",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("push --tags");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("tagbranch");
			const tag = `test-tag-${Date.now()}`;
			cleanupBranches.push(branch);
			cleanupTags.push(tag);
			const cwd = "/repo/work";

			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "tag" > tag.txt', { cwd });
			await ctx.bash.exec("git add tag.txt", { cwd });
			await ctx.bash.exec('git commit -m "for tag"', { cwd });
			await ctx.bash.exec(`git push -u origin ${branch}`, { cwd });

			await ctx.bash.exec(`git tag -a ${tag} -m "test tag"`, { cwd });
			const pushResult = await ctx.bash.exec("git push origin --tags", { cwd });
			expect(pushResult.exitCode).toBe(0);
		},
		TIMEOUT,
	);
});
