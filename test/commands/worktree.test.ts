import { describe, expect, test } from "bun:test";
import { TEST_ENV } from "../fixtures";
import { createTestBash, pathExists, readFile, runScenario } from "../util";

const FILES = { "/repo/README.md": "# Hello\n" };
const SETUP = ["git init", "git add .", 'git commit -m "init"'];

describe("git worktree add", () => {
	test("creates a worktree on a new branch (-b)", async () => {
		const { results, bash } = await runScenario(
			[...SETUP, "git worktree add /wt-feature -b feature"],
			{
				files: FILES,
				env: TEST_ENV,
			},
		);

		expect(results[3].exitCode).toBe(0);
		expect(await readFile(bash.fs, "/wt-feature/.git")).toBe(
			"gitdir: /repo/.git/worktrees/wt-feature\n",
		);
		expect(await readFile(bash.fs, "/wt-feature/README.md")).toBe("# Hello\n");
		expect(await readFile(bash.fs, "/repo/.git/worktrees/wt-feature/HEAD")).toBe(
			"ref: refs/heads/feature\n",
		);
		expect(await readFile(bash.fs, "/repo/.git/worktrees/wt-feature/commondir")).toBe("../..\n");
		expect(await pathExists(bash.fs, "/repo/.git/refs/heads/feature")).toBe(true);
		// The branch ref is shared — it must not live in the private dir.
		expect(await pathExists(bash.fs, "/repo/.git/worktrees/wt-feature/refs/heads/feature")).toBe(
			false,
		);
	});

	test("DWIMs a branch named after the path when none is given", async () => {
		const { results, bash } = await runScenario([...SETUP, "git worktree add /featurewt"], {
			files: FILES,
			env: TEST_ENV,
		});

		expect(results[3].exitCode).toBe(0);
		expect(await readFile(bash.fs, "/repo/.git/worktrees/featurewt/HEAD")).toBe(
			"ref: refs/heads/featurewt\n",
		);
		expect(await pathExists(bash.fs, "/repo/.git/refs/heads/featurewt")).toBe(true);
	});

	test("--detach checks out a detached HEAD", async () => {
		const { results, bash } = await runScenario([...SETUP, "git worktree add /det --detach"], {
			files: FILES,
			env: TEST_ENV,
		});

		expect(results[3].exitCode).toBe(0);
		const head = await readFile(bash.fs, "/repo/.git/worktrees/det/HEAD");
		expect(head).toMatch(/^[0-9a-f]{40}\n$/);
	});

	test("refuses a branch already checked out in another worktree", async () => {
		const { results } = await runScenario(
			[...SETUP, "git worktree add /wt-a -b shared", "git worktree add /wt-b shared"],
			{ files: FILES, env: TEST_ENV },
		);

		expect(results[4].exitCode).not.toBe(0);
		expect(results[4].stderr).toContain("'shared' is already used by worktree at '/wt-a'");
	});

	test("refuses an existing non-empty target path, quoting the path as typed", async () => {
		const { results, bash } = await runScenario(
			[
				...SETUP,
				"mkdir -p /repo/occupied",
				"echo x > /repo/occupied/file",
				"git worktree add occupied -b b",
			],
			{ files: FILES, env: TEST_ENV },
		);

		expect(results[5].exitCode).toBe(128);
		// git prints the progress line before validating the path, and the `-b`
		// branch it creates first leaks even though the add aborts.
		expect(results[5].stderr).toBe(
			"Preparing worktree (new branch 'b')\nfatal: 'occupied' already exists\n",
		);
		expect(await pathExists(bash.fs, "/repo/.git/refs/heads/b")).toBe(true);
	});

	test("-b on an existing branch fails with exit 255 after the progress line", async () => {
		const { results, bash } = await runScenario([...SETUP, "git worktree add /wt -b main"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[3].exitCode).toBe(255);
		expect(results[3].stderr).toBe(
			"Preparing worktree (new branch 'main')\nfatal: a branch named 'main' already exists\n",
		);
		// The failed add must not register a worktree.
		expect(await pathExists(bash.fs, "/wt")).toBe(false);
	});

	test("a refused add still prints the progress line first", async () => {
		const { results } = await runScenario(
			[...SETUP, "git worktree add /wt-a -b shared", "git worktree add /wt-b shared"],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[4].exitCode).toBe(128);
		expect(results[4].stderr).toBe(
			"Preparing worktree (checking out 'shared')\n" +
				"fatal: 'shared' is already used by worktree at '/wt-a'\n",
		);
	});

	test("a bare add onto an occupied path leaks the DWIM branch", async () => {
		const { results, bash } = await runScenario(
			[
				...SETUP,
				// Occupy the target path with a detached worktree (no branch created).
				"git worktree add --detach /wt-leak HEAD",
				"git worktree add /wt-leak",
			],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[4].exitCode).toBe(128);
		expect(results[4].stderr).toBe(
			"Preparing worktree (new branch 'wt-leak')\nfatal: '/wt-leak' already exists\n",
		);
		// git creates the DWIM branch before validating the path, so it survives.
		expect(await pathExists(bash.fs, "/repo/.git/refs/heads/wt-leak")).toBe(true);
	});

	test("prints the Preparing / HEAD-is-now-at confirmation", async () => {
		const { results } = await runScenario([...SETUP, "git worktree add /wt -b feature"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[3].stderr).toBe("Preparing worktree (new branch 'feature')\n");
		expect(results[3].stdout).toMatch(/^HEAD is now at [0-9a-f]{7} init\n$/);
	});

	test("--quiet suppresses the confirmation", async () => {
		const { results } = await runScenario([...SETUP, "git worktree add /wt -b feature -q"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[3].stdout).toBe("");
		expect(results[3].stderr).toBe("");
	});

	test("checks out an existing branch without creating a ref", async () => {
		const { results, bash } = await runScenario(
			[...SETUP, "git branch existing", "git worktree add /wt existing"],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[4].exitCode).toBe(0);
		expect(results[4].stderr).toContain("checking out 'existing'");
		expect(await readFile(bash.fs, "/repo/.git/worktrees/wt/HEAD")).toBe(
			"ref: refs/heads/existing\n",
		);
		expect(await readFile(bash.fs, "/wt/README.md")).toBe("# Hello\n");
	});

	test("records a creation reflog for the new branch", async () => {
		const { bash } = await runScenario([...SETUP, "git worktree add /wt -b feature"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(await readFile(bash.fs, "/repo/.git/logs/refs/heads/feature")).toContain(
			"branch: Created from HEAD",
		);
	});

	test("DWIMs a tracking branch from a unique remote branch", async () => {
		const bash = createTestBash({ files: FILES, env: TEST_ENV });
		for (const cmd of SETUP) await bash.exec(cmd);
		// Seed a remote-tracking ref directly (update-ref is not implemented).
		const revParse = "git rev-parse HEAD";
		const head = (await bash.exec(revParse)).stdout.trim();
		await bash.fs.writeFile("/repo/.git/refs/remotes/origin/feat", `${head}\n`);

		const addWorktree = "git worktree add /wt feat";
		const r = await bash.exec(addWorktree);
		expect(r.exitCode).toBe(0);
		expect(await readFile(bash.fs, "/repo/.git/worktrees/wt/HEAD")).toBe("ref: refs/heads/feat\n");
		expect(await pathExists(bash.fs, "/repo/.git/refs/heads/feat")).toBe(true);
	});

	test("infers --orphan on an unborn HEAD", async () => {
		const { results, bash } = await runScenario(["git init", "git worktree add /wt -b feature"], {
			files: {},
			env: TEST_ENV,
			cwd: "/repo",
		});
		expect(results[1].exitCode).toBe(0);
		expect(results[1].stderr).toBe(
			"No possible source branch, inferring '--orphan'\nPreparing worktree (new branch 'feature')\n",
		);
		expect(await readFile(bash.fs, "/repo/.git/worktrees/wt/HEAD")).toBe(
			"ref: refs/heads/feature\n",
		);
		// The branch ref stays unborn until the first commit.
		expect(await pathExists(bash.fs, "/repo/.git/refs/heads/feature")).toBe(false);
	});
});

describe("git worktree round-trip", () => {
	test("just-git discovers and operates inside a worktree it created", async () => {
		const { results } = await runScenario(
			[
				...SETUP,
				"git worktree add /wt -b feature",
				"cd /wt && git branch --show-current",
				"cd /wt && echo more >> README.md && git add README.md && git commit -m wt-commit",
				"git log --oneline feature",
			],
			{ files: FILES, env: TEST_ENV },
		);

		// HEAD inside the worktree resolves to the branch it was created on.
		expect(results[4].stdout.trim()).toBe("feature");
		// Committing inside the worktree succeeds (its private index + HEAD,
		// the shared objects + branch ref).
		expect(results[5].exitCode).toBe(0);
		// The commit landed on the shared branch, visible from the main worktree.
		expect(results[6].stdout).toContain("wt-commit");
	});
});

describe("cross-worktree porcelain guards", () => {
	const WITH_WT = [...SETUP, "git worktree add /wt -b feature"];

	test("switch refuses a branch checked out in another worktree", async () => {
		const { results } = await runScenario([...WITH_WT, "git switch feature"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[4].exitCode).not.toBe(0);
		expect(results[4].stderr).toContain("'feature' is already used by worktree at '/wt'");
	});

	test("checkout refuses a branch checked out in another worktree", async () => {
		const { results } = await runScenario([...WITH_WT, "git checkout feature"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[4].exitCode).not.toBe(0);
		expect(results[4].stderr).toContain("is already used by worktree at '/wt'");
	});

	test("--ignore-other-worktrees bypasses the switch guard", async () => {
		const { results } = await runScenario(
			[...WITH_WT, "git switch --ignore-other-worktrees feature"],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[4].exitCode).toBe(0);
	});

	test("checkout -B refuses to reset a branch checked out in another worktree", async () => {
		const { results, bash } = await runScenario([...WITH_WT, "git checkout -B feature"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[4].exitCode).not.toBe(0);
		expect(results[4].stderr).toContain("'feature' is already used by worktree at '/wt'");
		// HEAD must not move to the refused branch.
		expect(await readFile(bash.fs, "/repo/.git/HEAD")).toBe("ref: refs/heads/main\n");
	});

	test("switch -C refuses to reset a branch checked out in another worktree", async () => {
		const { results, bash } = await runScenario([...WITH_WT, "git switch -C feature"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[4].exitCode).not.toBe(0);
		expect(results[4].stderr).toContain("'feature' is already used by worktree at '/wt'");
		expect(await readFile(bash.fs, "/repo/.git/HEAD")).toBe("ref: refs/heads/main\n");
	});

	test("--ignore-other-worktrees bypasses the checkout -B guard", async () => {
		const { results } = await runScenario(
			[...WITH_WT, "git checkout -B feature --ignore-other-worktrees"],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[4].exitCode).toBe(0);
	});

	test("switch reports an in-progress merge before the worktree guard", async () => {
		const bash = createTestBash({ files: FILES, env: TEST_ENV });
		const exec = (cmd: string) => bash.exec(cmd);

		for (const cmd of [...SETUP, "git worktree add /wt -b feature", "git switch -c side"]) {
			await exec(cmd);
		}
		await bash.fs.writeFile("/repo/README.md", "# Side\n");
		for (const cmd of ["git add .", 'git commit -m "side"', "git switch main"]) {
			await exec(cmd);
		}
		await bash.fs.writeFile("/repo/README.md", "# Main\n");
		for (const cmd of ["git add .", 'git commit -m "main"', "git merge side"]) {
			await exec(cmd);
		}

		const switchDuringMerge = "git switch feature";
		const res = await exec(switchDuringMerge);
		expect(res.exitCode).not.toBe(0);
		expect(res.stderr).toContain("cannot switch branch while merging");
		expect(res.stderr).not.toContain("used by worktree");
	});

	test("branch -d refuses a branch checked out elsewhere", async () => {
		const { results } = await runScenario([...WITH_WT, "git branch -d feature"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[4].exitCode).not.toBe(0);
		expect(results[4].stderr).toContain("cannot delete branch 'feature' used by worktree at '/wt'");
	});

	test("branch list marks a branch checked out in another worktree with +", async () => {
		const { results } = await runScenario([...WITH_WT, "git branch"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[4].stdout).toContain("+ feature");
	});

	test("branch -m repoints a sibling worktree's HEAD", async () => {
		const { results, bash } = await runScenario([...WITH_WT, "git branch -m feature renamed"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[4].exitCode).toBe(0);
		expect(await readFile(bash.fs, "/repo/.git/worktrees/wt/HEAD")).toBe(
			"ref: refs/heads/renamed\n",
		);
	});

	test("log --all reaches a commit held only by another worktree's HEAD", async () => {
		const bash = createTestBash({ files: FILES, env: TEST_ENV });
		const exec = (cmd: string) => bash.exec(cmd);

		for (const cmd of SETUP) await exec(cmd);
		await bash.fs.writeFile("/repo/README.md", "# two\n");
		for (const cmd of ["git add .", 'git commit -m "c2"']) await exec(cmd);

		const revParseHead = "git rev-parse HEAD";
		const c2 = (await exec(revParseHead)).stdout.trim();

		// Pin c2 to a detached worktree HEAD, then move the only branch off it;
		// c2 is now reachable solely through the worktree's HEAD.
		for (const cmd of ["git worktree add /wt --detach HEAD", "git reset --hard HEAD~1"]) {
			await exec(cmd);
		}

		const logAll = "git log --all --oneline";
		const res = await exec(logAll);
		expect(res.stdout).toContain(c2.slice(0, 7));
	});
});

describe("linked-worktree shared-state routing", () => {
	test("gc from a linked worktree packs into the shared object store", async () => {
		const { results, bash } = await runScenario(
			[
				...SETUP,
				"git worktree add /wt -b feat",
				"cd /wt && echo more >> README.md && git add README.md && git commit -m wtc",
				"cd /wt && git gc",
			],
			{ files: FILES, env: TEST_ENV },
		);

		expect(results[5].exitCode).toBe(0);
		// The new pack must land in the shared object store, where the store
		// reads from — never in the private admin dir.
		expect(await pathExists(bash.fs, "/repo/.git/objects/pack")).toBe(true);
		const sharedPacks = (await bash.fs.readdir("/repo/.git/objects/pack")).filter((f) =>
			f.endsWith(".pack"),
		);
		expect(sharedPacks.length).toBeGreaterThan(0);
		expect(await pathExists(bash.fs, "/repo/.git/worktrees/wt/objects/pack")).toBe(false);
	});

	test("config --list inside a linked worktree reads the shared config", async () => {
		const { results } = await runScenario(
			[
				...SETUP,
				"git worktree add /wt -b feat",
				"cd /wt && git config user.name Alice",
				"cd /wt && git config --list",
			],
			{ files: FILES, env: TEST_ENV },
		);

		expect(results[5].stdout).toContain("user.name=Alice");
	});

	test("a worktree whose .git gitlink is gone is reported prunable and pruned", async () => {
		const { results, bash } = await runScenario([...SETUP, "git worktree add /wt -b feat"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[3].exitCode).toBe(0);

		// Remove the .git gitlink file but leave the worktree directory in place.
		await bash.fs.rm("/wt/.git");

		const listCmd = "git worktree list --porcelain";
		expect((await bash.exec(listCmd)).stdout).toContain(
			"prunable gitdir file points to non-existent location",
		);

		const pruneCmd = "git worktree prune";
		await bash.exec(pruneCmd);
		expect(await pathExists(bash.fs, "/repo/.git/worktrees/wt")).toBe(false);
	});
});

describe("git worktree list", () => {
	test("porcelain output is blank-line-terminated, main first", async () => {
		const { results } = await runScenario(
			[
				...SETUP,
				"git worktree add /wt-feature -b feature",
				"git rev-parse HEAD",
				"git worktree list --porcelain",
			],
			{ files: FILES, env: TEST_ENV },
		);

		const head = results[4].stdout.trim();
		expect(results[5].stdout).toBe(
			`worktree /repo\nHEAD ${head}\nbranch refs/heads/main\n\n` +
				`worktree /wt-feature\nHEAD ${head}\nbranch refs/heads/feature\n\n`,
		);
	});

	test("porcelain annotates a locked worktree with its reason", async () => {
		const { results } = await runScenario(
			[
				...SETUP,
				"git worktree add /wl -b lk",
				"git worktree lock --reason busy /wl",
				"git worktree list --porcelain",
			],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[5].stdout).toContain("locked busy");
	});

	test("porcelain annotates a worktree whose directory is gone as prunable", async () => {
		const { results } = await runScenario(
			[
				...SETUP,
				"git worktree add /vanish -b vanish",
				"rm -rf /vanish",
				"git worktree list --porcelain",
			],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[5].stdout).toContain("prunable");
	});

	test("non-porcelain uses a single space and a locked suffix", async () => {
		const { results } = await runScenario(
			[...SETUP, "git worktree add /wl -b lk", "git worktree lock /wl", "git worktree list"],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[5].stdout).toMatch(/\/wl +[0-9a-f]{7} \[lk\] locked\n/);
		// The longest path (the main worktree) gets exactly one separator space.
		expect(results[5].stdout).toMatch(/\/repo [0-9a-f]{7} \[main\]\n/);
	});

	test("a bare repository lists its bare main worktree", async () => {
		const { results } = await runScenario(["git init --bare", "git worktree list --porcelain"], {
			files: {},
			env: TEST_ENV,
			cwd: "/bare",
		});
		expect(results[1].stdout).toBe("worktree /bare\nbare\n\n");
	});
});

describe("git worktree remove / prune / lock / unlock", () => {
	test("remove deletes the worktree and its admin dir", async () => {
		const { results, bash } = await runScenario(
			[...SETUP, "git worktree add /gone -b gone", "git worktree remove /gone"],
			{ files: FILES, env: TEST_ENV },
		);

		expect(results[4].exitCode).toBe(0);
		expect(await pathExists(bash.fs, "/gone")).toBe(false);
		expect(await pathExists(bash.fs, "/repo/.git/worktrees/gone")).toBe(false);
	});

	test("prune removes admin dirs whose worktree directory is gone", async () => {
		const { results, bash } = await runScenario(
			[...SETUP, "git worktree add /vanish -b vanish", "rm -rf /vanish", "git worktree prune"],
			{ files: FILES, env: TEST_ENV },
		);

		expect(results[5].exitCode).toBe(0);
		expect(await pathExists(bash.fs, "/repo/.git/worktrees/vanish")).toBe(false);
	});

	test("prune reaps an admin dir whose gitdir pointer is gone", async () => {
		const { results, bash } = await runScenario(
			[
				...SETUP,
				"git worktree add /wt -b wt",
				"rm /repo/.git/worktrees/wt/gitdir",
				"git worktree prune -v",
			],
			{ files: FILES, env: TEST_ENV },
		);
		expect(await pathExists(bash.fs, "/repo/.git/worktrees/wt")).toBe(false);
		expect(results[5].stdout).toContain("gitdir file does not exist");
	});

	test("prune skips a locked worktree even when its directory is gone", async () => {
		const { bash } = await runScenario(
			[
				...SETUP,
				"git worktree add /lk -b lk",
				"git worktree lock /lk",
				"rm -rf /lk",
				"git worktree prune",
			],
			{ files: FILES, env: TEST_ENV },
		);
		expect(await pathExists(bash.fs, "/repo/.git/worktrees/lk")).toBe(true);
	});

	test("lock then unlock toggles the locked marker", async () => {
		const { results, bash } = await runScenario(
			[...SETUP, "git worktree add /lk -b lk", "git worktree lock /lk", "git worktree unlock /lk"],
			{ files: FILES, env: TEST_ENV },
		);

		expect(results[3].exitCode).toBe(0);
		expect(results[4].exitCode).toBe(0);
		expect(results[5].exitCode).toBe(0);
		expect(await pathExists(bash.fs, "/repo/.git/worktrees/lk/locked")).toBe(false);
	});

	test("remove refuses the main worktree, quoting the path as typed", async () => {
		const { results } = await runScenario([...SETUP, "git worktree remove /repo"], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[3].exitCode).toBe(128);
		expect(results[3].stderr).toBe("fatal: '/repo' is a main working tree\n");
	});

	test("remove refuses the main worktree given as '.'", async () => {
		const { results } = await runScenario([...SETUP, "git worktree remove ."], {
			files: FILES,
			env: TEST_ENV,
		});
		expect(results[3].exitCode).toBe(128);
		expect(results[3].stderr).toBe("fatal: '.' is a main working tree\n");
	});

	test("remove refuses a dirty worktree without --force", async () => {
		const { results, bash } = await runScenario(
			[
				...SETUP,
				"git worktree add /dirty -b dirty",
				"echo more >> /dirty/README.md",
				"git worktree remove /dirty",
			],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[5].exitCode).toBe(128);
		expect(results[5].stderr).toBe(
			"fatal: '/dirty' contains modified or untracked files, use --force to delete it\n",
		);
		expect(await pathExists(bash.fs, "/dirty")).toBe(true);
	});

	test("remove -f deletes a dirty worktree", async () => {
		const { results, bash } = await runScenario(
			[
				...SETUP,
				"git worktree add /dirty -b dirty",
				"echo more >> /dirty/README.md",
				"git worktree remove -f /dirty",
			],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[5].exitCode).toBe(0);
		expect(await pathExists(bash.fs, "/dirty")).toBe(false);
	});

	test("remove of a locked worktree reports the lock reason and needs -f -f", async () => {
		const { results } = await runScenario(
			[
				...SETUP,
				"git worktree add /lk -b lk",
				"git worktree lock --reason busy /lk",
				"git worktree remove /lk",
			],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[5].exitCode).toBe(128);
		expect(results[5].stderr).toBe(
			"fatal: cannot remove a locked working tree, lock reason: busy\nuse 'remove -f -f' to override or unlock first\n",
		);
	});

	test("remove of a worktree locked with no reason uses the semicolon form", async () => {
		const { results } = await runScenario(
			[...SETUP, "git worktree add /lk -b lk", "git worktree lock /lk", "git worktree remove /lk"],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[5].stderr).toBe(
			"fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first\n",
		);
	});

	test("remove -f -f deletes a locked worktree", async () => {
		const { results, bash } = await runScenario(
			[
				...SETUP,
				"git worktree add /lk -b lk",
				"git worktree lock /lk",
				"git worktree remove -f -f /lk",
			],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[5].exitCode).toBe(0);
		expect(await pathExists(bash.fs, "/repo/.git/worktrees/lk")).toBe(false);
	});

	test("lock and unlock errors use the fatal: prefix", async () => {
		const { results } = await runScenario(
			[...SETUP, "git worktree add /lk -b lk", "git worktree unlock /lk"],
			{ files: FILES, env: TEST_ENV },
		);
		expect(results[4].stderr).toBe("fatal: '/lk' is not locked\n");
	});
});
