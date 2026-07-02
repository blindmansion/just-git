// Command-layer guardrails for the attribute-resolver seam.
//
// These lock the COMMAND-LAYER merge-driver boundaries (merge, cherry-pick,
// revert, rebase, pull) now that they resolve through the single `attributes`
// seam (`bindAttributes`) — the repo/SDK boundaries are covered by
// test/repo/merge-driver.test.ts. A driver applied to every path uses
// `everyPath({ merge })`; `.gitattributes merge=<name>` selection uses
// `gitAttributes()`.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { everyPath, gitAttributes } from "../../src/lib/attributes/attribute-resolver.ts";
import type { MergeDriver } from "../../src/lib/merge-ort.ts";
import { resolveHead } from "../../src/lib/refs/refs.ts";
import { findRepo } from "../../src/lib/repo.ts";
import { TEST_ENV, textMergeDriver } from "../fixtures.ts";

/** A Bash whose git applies a custom merge driver to every path. */
function bashWithDriver(driver: MergeDriver): { bash: Bash; fs: InMemoryFs } {
	const fs = new InMemoryFs();
	const git = createGit({ attributes: everyPath({ merge: driver }) });
	const bash = new Bash({ fs, cwd: "/repo", env: TEST_ENV, customCommands: [git] });
	return { bash, fs };
}

/** Resolve a path through the driver, otherwise decline (diff3 fallback). */
function resolvePath(path: string, content: string): MergeDriver {
	return textMergeDriver((_ctx, input) =>
		input.path === path ? { content, conflict: false } : null,
	);
}

describe("merge driver — command-layer boundaries (Phase 0 baseline)", () => {
	// C1 — git merge
	test("git merge honors mergeDriver", async () => {
		const { bash } = bashWithDriver(resolvePath("shared.txt", "driver-merged\n"));

		await bash.writeFile("/repo/shared.txt", "line1\nline2\nline3\n");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "base"');

		await bash.exec("git checkout -b feature");
		await bash.writeFile("/repo/shared.txt", "line1\ntheirs\nline3\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "theirs"');

		await bash.exec("git checkout main");
		await bash.writeFile("/repo/shared.txt", "line1\nours\nline3\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "ours"');

		const res = await bash.exec("git merge feature");
		expect(res.exitCode).toBe(0);
		expect(await bash.readFile("/repo/shared.txt")).toBe("driver-merged\n");
	});

	// C2 — git cherry-pick
	test("git cherry-pick honors mergeDriver", async () => {
		const { bash, fs } = bashWithDriver(resolvePath("file.txt", "cp-merged\n"));

		await bash.writeFile("/repo/file.txt", "original\n");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		await bash.exec("git checkout -b feature");
		await bash.writeFile("/repo/file.txt", "feature version\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "feature change"');

		const repo = await findRepo(fs, "/repo");
		const featureHash = await resolveHead(repo!);

		await bash.exec("git checkout main");
		await bash.writeFile("/repo/file.txt", "main version\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "main change"');

		const res = await bash.exec(`git cherry-pick ${featureHash}`);
		expect(res.exitCode).toBe(0);
		expect(await bash.readFile("/repo/file.txt")).toBe("cp-merged\n");
	});

	// C3 — git revert
	test("git revert honors mergeDriver", async () => {
		const { bash, fs } = bashWithDriver(resolvePath("file.txt", "revert-merged\n"));

		await bash.writeFile("/repo/file.txt", "base\n");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "base"');

		await bash.writeFile("/repo/file.txt", "change1\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "change1"');

		const repo = await findRepo(fs, "/repo");
		const change1Hash = await resolveHead(repo!);

		await bash.writeFile("/repo/file.txt", "change2\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "change2"');

		// Reverting change1 conflicts with change2 in the same region; the
		// driver clears it before markers surface.
		const res = await bash.exec(`git revert ${change1Hash}`);
		expect(res.exitCode).toBe(0);
		expect(await bash.readFile("/repo/file.txt")).toBe("revert-merged\n");
	});

	// C4 — git rebase
	test("git rebase honors mergeDriver during replay", async () => {
		const { bash } = bashWithDriver(resolvePath("shared.txt", "rebase-merged\n"));

		await bash.writeFile("/repo/shared.txt", "line1\nline2\nline3\n");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "base"');

		await bash.exec("git checkout -b feature");
		await bash.writeFile("/repo/shared.txt", "line1\nfeature\nline3\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "feature edit"');

		await bash.exec("git checkout main");
		await bash.writeFile("/repo/shared.txt", "line1\nmain\nline3\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "main edit"');

		await bash.exec("git checkout feature");
		const res = await bash.exec("git rebase main");
		expect(res.exitCode).toBe(0);
		expect(await bash.readFile("/repo/shared.txt")).toBe("rebase-merged\n");
	});

	// C5 — git pull --no-rebase
	test("git pull --no-rebase honors mergeDriver", async () => {
		const { bash } = bashWithDriver(resolvePath("README.md", "pull-merged\n"));

		await bash.writeFile("/remote/README.md", "base\n");
		await bash.exec("git init", { cwd: "/remote" });
		await bash.exec("git add .", { cwd: "/remote" });
		await bash.exec('git commit -m "initial"', { cwd: "/remote" });
		await bash.exec("git clone /remote /local", { cwd: "/" });

		await bash.writeFile("/remote/README.md", "remote version\n");
		await bash.exec("git add .", { cwd: "/remote" });
		await bash.exec('git commit -m "remote change"', { cwd: "/remote" });

		await bash.writeFile("/local/README.md", "local version\n");
		await bash.exec("git add .", { cwd: "/local" });
		await bash.exec('git commit -m "local change"', { cwd: "/local" });

		const res = await bash.exec("git pull --no-rebase", { cwd: "/local" });
		expect(res.exitCode).toBe(0);
		expect(await bash.readFile("/local/README.md")).toBe("pull-merged\n");
	});
});

describe("merge driver — `.gitattributes merge=<name>` selection (Phase 3)", () => {
	// §3: with the AttributeResolver seam, `gitAttributes()` reads in-tree
	// `.gitattributes` and selects a per-path merge driver — here the built-in
	// `merge=union` — with no global driver configured.
	test("`.gitattributes merge=union` auto-resolves without a global driver", async () => {
		const fs = new InMemoryFs();
		const git = createGit({ attributes: gitAttributes() });
		const bash = new Bash({ fs, cwd: "/repo", env: TEST_ENV, customCommands: [git] });

		await bash.writeFile("/repo/.gitattributes", "*.txt merge=union\n");
		await bash.writeFile("/repo/data.txt", "base\n");
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "base"');

		// Both sides rewrite the SAME line — a true content conflict that
		// diff3 cannot resolve, so only a union driver could clear it.
		await bash.exec("git checkout -b feature");
		await bash.writeFile("/repo/data.txt", "theirs\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "theirs"');

		await bash.exec("git checkout main");
		await bash.writeFile("/repo/data.txt", "ours\n");
		await bash.exec("git add .");
		await bash.exec('git commit -m "ours"');

		const res = await bash.exec("git merge feature");
		// A union merge keeps both sides and leaves no conflict markers.
		expect(res.exitCode).toBe(0);
		const merged = await bash.readFile("/repo/data.txt");
		expect(merged).not.toContain("<<<<<<<");
	});
});
