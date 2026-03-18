import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";
import { createGit } from "../../src/git";
import type { GitHooks } from "../../src/hooks";
import { BASIC_REPO } from "../fixtures";
import { createHookBash, TEST_ENV } from "./helpers";

describe("command lifecycle emissions", () => {
	test("clone emits pre/post clone events", async () => {
		let preTarget = "";
		let postBranch: string | null = null;

		const hooks: GitHooks = {
			preClone: (event) => {
				preTarget = event.targetPath;
			},
			postClone: (event) => {
				postBranch = event.branch;
			},
		};

		const git = createGit({ hooks });
		const bash = new Bash({
			cwd: "/origin",
			files: { "/origin/README.md": "# hi" },
			customCommands: [git],
			env: TEST_ENV,
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');

		const result = await bash.exec("git clone /origin /copy", { cwd: "/" });
		expect(result.exitCode).toBe(0);
		expect(preTarget).toBe("/copy");
		expect(postBranch as unknown as string).toBe("main");
	});

	test("fetch emits pre-fetch and can reject", async () => {
		let seenRemote = "";
		const hooks: GitHooks = {
			preFetch: (event) => {
				seenRemote = event.remote;
				return { reject: true, message: "no fetch" };
			},
		};

		const git = createGit({ hooks });
		const bash = new Bash({
			cwd: "/remote",
			files: { "/remote/README.md": "# hello" },
			customCommands: [git],
			env: TEST_ENV,
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');
		await bash.exec("git clone /remote /local", { cwd: "/" });

		const result = await bash.exec("git fetch origin", { cwd: "/local" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("no fetch");
		expect(seenRemote).toBe("origin");
	});

	test("reset emits pre/post reset", async () => {
		let mode = "";
		let targetHash = "";
		const hooks: GitHooks = {
			preReset: (event) => {
				mode = event.mode;
			},
			postReset: (event) => {
				targetHash = event.targetHash ?? "";
			},
		};

		const { bash } = createHookBash({ files: BASIC_REPO }, { hooks });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');
		await bash.exec("echo 'x' >> /repo/README.md");

		const result = await bash.exec("git reset --hard HEAD");
		expect(result.exitCode).toBe(0);
		expect(mode).toBe("hard");
		expect(targetHash).toHaveLength(40);
	});

	test("clean/rm/stash/cherry-pick pre hooks can reject", async () => {
		const hooks: GitHooks = {
			preClean: () => ({ reject: true, message: "stop clean" }),
			preRm: () => ({ reject: true, message: "stop rm" }),
			preStash: () => ({ reject: true, message: "stop stash" }),
			preCherryPick: () => ({ reject: true, message: "stop cherry-pick" }),
		};

		const { bash } = createHookBash({ files: BASIC_REPO }, { hooks });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');
		await bash.exec("echo tmp > /repo/tmp.txt");
		await bash.exec("echo x > /repo/rmme.txt");
		await bash.exec("git add rmme.txt");
		await bash.exec('git commit -m "add rmme"');
		await bash.exec("git checkout -b feature");
		await bash.exec("echo feat > /repo/feat.txt");
		await bash.exec("git add feat.txt");
		await bash.exec('git commit -m "feat"');
		await bash.exec("git checkout main");

		const clean = await bash.exec("git clean -f");
		expect(clean.stderr).toBe("stop clean");

		const rm = await bash.exec("git rm rmme.txt");
		expect(rm.stderr).toBe("stop rm");

		const stash = await bash.exec("git stash");
		expect(stash.stderr).toBe("stop stash");

		const hash = (await bash.exec("git rev-parse feature")).stdout.trim();
		const cp = await bash.exec(`git cherry-pick ${hash}`);
		expect(cp.stderr).toBe("stop cherry-pick");
	});
});
