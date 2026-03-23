import { afterEach, describe, expect, test } from "bun:test";
import {
	createAuthBash,
	loadNetworkEnv,
	type NetworkEnv,
	skipLog,
	uniqueRef,
} from "./network-helpers.ts";

const TIMEOUT = 60000;

describe.skip("Smart HTTP pull", () => {
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
		"pull fast-forward",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("pull ff");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("pullff");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			// Create branch, commit, push
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec(`git push -u origin ${branch}`, { cwd });
			await ctx.bash.exec('echo "ahead" > ahead.txt', { cwd });
			await ctx.bash.exec("git add ahead.txt", { cwd });
			await ctx.bash.exec('git commit -m "ahead"', { cwd });
			await ctx.bash.exec(`git push origin ${branch}`, { cwd });

			// Reset local branch back one commit
			await ctx.bash.exec("git reset --hard HEAD~1", { cwd });

			// Pull should fast-forward
			const pullResult = await ctx.bash.exec(`git pull origin ${branch}`, {
				cwd,
			});
			expect(pullResult.exitCode).toBe(0);

			// The file should be back
			const statusResult = await ctx.bash.exec("git status", { cwd });
			expect(statusResult.stdout).toContain("nothing to commit");

			const logResult = await ctx.bash.exec("git log --oneline -1", { cwd });
			expect(logResult.stdout).toContain("ahead");
		},
		TIMEOUT,
	);

	test(
		"pull --ff-only rejects diverged history",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("pull ff-only reject");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("pullffonly");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			// Create branch, push a commit
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "remote" > remote.txt', { cwd });
			await ctx.bash.exec("git add remote.txt", { cwd });
			await ctx.bash.exec('git commit -m "remote commit"', { cwd });
			await ctx.bash.exec(`git push -u origin ${branch}`, { cwd });

			// Reset and make a divergent local commit
			await ctx.bash.exec("git reset --hard HEAD~1", { cwd });
			await ctx.bash.exec('echo "local" > local.txt', { cwd });
			await ctx.bash.exec("git add local.txt", { cwd });
			await ctx.bash.exec('git commit -m "local commit"', { cwd });

			// --ff-only should reject
			const pullResult = await ctx.bash.exec(`git pull --ff-only origin ${branch}`, { cwd });
			expect(pullResult.exitCode).not.toBe(0);
			expect(pullResult.stderr).toContain("Not possible to fast-forward");
		},
		TIMEOUT,
	);

	test(
		"pull uses tracking config without explicit remote/branch",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("pull tracking");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("pulltrack");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			// Create branch, push with -u to set up tracking
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec(`git push -u origin ${branch}`, { cwd });

			// Push a commit
			await ctx.bash.exec('echo "tracked" > tracked.txt', { cwd });
			await ctx.bash.exec("git add tracked.txt", { cwd });
			await ctx.bash.exec('git commit -m "tracked commit"', { cwd });
			await ctx.bash.exec(`git push origin ${branch}`, { cwd });

			// Reset local back
			await ctx.bash.exec("git reset --hard HEAD~1", { cwd });

			// Pull with NO args — should use tracking config
			const pullResult = await ctx.bash.exec("git pull", { cwd });
			expect(pullResult.exitCode).toBe(0);

			const logResult = await ctx.bash.exec("git log --oneline -1", { cwd });
			expect(logResult.stdout).toContain("tracked commit");
		},
		TIMEOUT,
	);

	test(
		"pull three-way merge",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("pull merge");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("pullmerge");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			// Create branch, push a commit
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "base" > base.txt', { cwd });
			await ctx.bash.exec("git add base.txt", { cwd });
			await ctx.bash.exec('git commit -m "base"', { cwd });
			await ctx.bash.exec(`git push -u origin ${branch}`, { cwd });

			// Add another commit and push (this will be the "remote" change)
			await ctx.bash.exec('echo "remote-change" > remote-only.txt', { cwd });
			await ctx.bash.exec("git add remote-only.txt", { cwd });
			await ctx.bash.exec('git commit -m "remote change"', { cwd });
			await ctx.bash.exec(`git push origin ${branch}`, { cwd });

			// Reset local to before the remote change and make a different commit
			await ctx.bash.exec("git reset --hard HEAD~1", { cwd });
			await ctx.bash.exec('echo "local-change" > local-only.txt', { cwd });
			await ctx.bash.exec("git add local-only.txt", { cwd });
			await ctx.bash.exec('git commit -m "local change"', { cwd });

			// Pull should do a three-way merge
			const pullResult = await ctx.bash.exec(`git pull origin ${branch}`, {
				cwd,
			});
			expect(pullResult.exitCode).toBe(0);

			// Both files should exist
			const logResult = await ctx.bash.exec("git log --oneline -5", { cwd });
			expect(logResult.stdout).toContain("Merge");
		},
		TIMEOUT,
	);

	test(
		"pull with conflict leaves conflict markers",
		async () => {
			const ctx = setup();
			if (!ctx) {
				skipLog("pull conflict");
				return;
			}

			if (!(await cloneFixture(ctx.bash, ctx.net))) return;
			const branch = uniqueRef("pullconflict");
			cleanupBranches.push(branch);
			const cwd = "/repo/work";

			// Create branch with a shared file, push
			await ctx.bash.exec(`git checkout -b ${branch}`, { cwd });
			await ctx.bash.exec('echo "original" > shared.txt', { cwd });
			await ctx.bash.exec("git add shared.txt", { cwd });
			await ctx.bash.exec('git commit -m "base"', { cwd });
			await ctx.bash.exec(`git push -u origin ${branch}`, { cwd });

			// Push a "remote" change to the same file
			await ctx.bash.exec('echo "remote-version" > shared.txt', { cwd });
			await ctx.bash.exec("git add shared.txt", { cwd });
			await ctx.bash.exec('git commit -m "remote change"', { cwd });
			await ctx.bash.exec(`git push origin ${branch}`, { cwd });

			// Reset local and make a conflicting change to the same file
			await ctx.bash.exec("git reset --hard HEAD~1", { cwd });
			await ctx.bash.exec('echo "local-version" > shared.txt', { cwd });
			await ctx.bash.exec("git add shared.txt", { cwd });
			await ctx.bash.exec('git commit -m "local change"', { cwd });

			// Pull should result in a conflict
			const pullResult = await ctx.bash.exec(`git pull origin ${branch}`, {
				cwd,
			});
			expect(pullResult.exitCode).not.toBe(0);

			// Working tree should have conflict markers
			const catResult = await ctx.bash.exec("cat shared.txt", { cwd });
			expect(catResult.stdout).toContain("<<<<<<<");
			expect(catResult.stdout).toContain(">>>>>>>");

			// Status should show unmerged paths
			const statusResult = await ctx.bash.exec("git status", { cwd });
			expect(statusResult.stdout).toContain("Unmerged");
		},
		TIMEOUT,
	);
});
