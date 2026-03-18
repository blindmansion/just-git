import { describe, expect, test } from "bun:test";
import { collectRebaseSymmetricPlan } from "../../src/lib/rebase";
import { findRepo } from "../../src/lib/repo";
import { resolveRevision } from "../../src/lib/rev-parse";
import { RealGitHarness } from "../oracle/real-harness";
import { createTestBash } from "../util";

const BASE_ENV = {
	GIT_AUTHOR_NAME: "Test Author",
	GIT_AUTHOR_EMAIL: "author@test.com",
	GIT_COMMITTER_NAME: "Test Committer",
	GIT_COMMITTER_EMAIL: "committer@test.com",
};

function commitEnv(counter: number): Record<string, string> {
	const ts = `${1000000000 + counter} +0000`;
	return {
		...BASE_ENV,
		GIT_AUTHOR_DATE: ts,
		GIT_COMMITTER_DATE: ts,
	};
}

async function readRevList(real: RealGitHarness, rangeExpr: string): Promise<string[]> {
	const res = await real.git(
		`rev-list --reverse --topo-order --right-only --max-parents=1 ${rangeExpr}`,
	);
	expect(res.exitCode).toBe(0);
	return res.stdout
		.trim()
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

async function resolvePlanInputs(bash: ReturnType<typeof createTestBash>): Promise<{
	gitCtx: NonNullable<Awaited<ReturnType<typeof findRepo>>>;
	upstream: string;
	head: string;
}> {
	const gitCtx = await findRepo(bash.fs, "/repo");
	expect(gitCtx).not.toBeNull();
	if (!gitCtx) {
		throw new Error("expected git context");
	}

	const upstream = await resolveRevision(gitCtx, "main");
	const head = await resolveRevision(gitCtx, "feature");
	expect(upstream).not.toBeNull();
	expect(head).not.toBeNull();
	if (!upstream || !head) {
		throw new Error("expected main and feature revisions");
	}

	return { gitCtx, upstream, head };
}

describe("rebase planner", () => {
	test("matches rev-list for linear divergence", async () => {
		const real = await RealGitHarness.create();
		const bash = createTestBash({ env: BASE_ENV });
		let c = 1;

		const run = async (command: string, env?: Record<string, string>) => {
			const [rReal, rVirt] = await Promise.all([
				real.git(command, env),
				bash.exec(`git ${command}`, { env }),
			]);
			expect(rReal.exitCode).toBe(0);
			expect(rVirt.exitCode).toBe(0);
		};

		try {
			await run("init");
			await bash.fs.writeFile("/repo/base.txt", "base\n");
			await real.writeFile("base.txt", "base\n");
			await run("add .");
			await run('commit -m "base"', commitEnv(c++));

			await run("branch feature");

			await bash.fs.writeFile("/repo/main.txt", "main-1\n");
			await real.writeFile("main.txt", "main-1\n");
			await run("add main.txt");
			await run('commit -m "main-1"', commitEnv(c++));

			await run("checkout feature");
			await bash.fs.writeFile("/repo/feature.txt", "feature-1\n");
			await real.writeFile("feature.txt", "feature-1\n");
			await run("add feature.txt");
			await run('commit -m "feature-1"', commitEnv(c++));

			const { gitCtx, upstream, head } = await resolvePlanInputs(bash);
			const plan = await collectRebaseSymmetricPlan(gitCtx, upstream, head);
			const expectedRight = await readRevList(real, "main...feature");
			const expectedLeft = await readRevList(real, "feature...main");

			expect(plan.right.map((e) => e.hash)).toEqual(expectedRight);
			expect(plan.left.map((e) => e.hash)).toEqual(expectedLeft);
		} finally {
			await real.cleanup();
		}
	});

	test("matches rev-list on merge-heavy symmetric history", async () => {
		const real = await RealGitHarness.create();
		const bash = createTestBash({ env: BASE_ENV });
		let c = 1;

		const run = async (command: string, env?: Record<string, string>) => {
			const [rReal, rVirt] = await Promise.all([
				real.git(command, env),
				bash.exec(`git ${command}`, { env }),
			]);
			expect(rReal.exitCode).toBe(0);
			expect(rVirt.exitCode).toBe(0);
		};

		try {
			await run("init");
			await bash.fs.writeFile("/repo/base.txt", "base\n");
			await real.writeFile("base.txt", "base\n");
			await run("add .");
			await run('commit -m "base"', commitEnv(c++));

			await run("branch feature");

			await bash.fs.writeFile("/repo/main-a.txt", "main-a\n");
			await real.writeFile("main-a.txt", "main-a\n");
			await run("add main-a.txt");
			await run('commit -m "main-a"', commitEnv(c++));

			await bash.fs.writeFile("/repo/main-b.txt", "main-b\n");
			await real.writeFile("main-b.txt", "main-b\n");
			await run("add main-b.txt");
			await run('commit -m "main-b"', commitEnv(c++));

			await run("checkout feature");
			await bash.fs.writeFile("/repo/feature-a.txt", "feature-a\n");
			await real.writeFile("feature-a.txt", "feature-a\n");
			await run("add feature-a.txt");
			await run('commit -m "feature-a"', commitEnv(c++));

			await run("branch helper");

			await bash.fs.writeFile("/repo/feature-b.txt", "feature-b\n");
			await real.writeFile("feature-b.txt", "feature-b\n");
			await run("add feature-b.txt");
			await run('commit -m "feature-b"', commitEnv(c++));

			await run("checkout helper");
			await bash.fs.writeFile("/repo/helper.txt", "helper\n");
			await real.writeFile("helper.txt", "helper\n");
			await run("add helper.txt");
			await run('commit -m "helper"', commitEnv(c++));

			await run("checkout feature");
			await run("merge helper", commitEnv(c++));

			await bash.fs.writeFile("/repo/feature-c.txt", "feature-c\n");
			await real.writeFile("feature-c.txt", "feature-c\n");
			await run("add feature-c.txt");
			await run('commit -m "feature-c"', commitEnv(c++));

			const { gitCtx, upstream, head } = await resolvePlanInputs(bash);
			const plan = await collectRebaseSymmetricPlan(gitCtx, upstream, head);
			const expectedRight = await readRevList(real, "main...feature");
			const expectedLeft = await readRevList(real, "feature...main");

			expect(plan.right.map((e) => e.hash)).toEqual(expectedRight);
			expect(plan.left.map((e) => e.hash)).toEqual(expectedLeft);
		} finally {
			await real.cleanup();
		}
	});
});
