import { describe, expect, test } from "bun:test";
import { BASIC_REPO } from "../fixtures";
import { createHookBash } from "./helpers";

describe("command lifecycle emissions", () => {
	test("clone emits pre/post clone events", async () => {
		const { bash, git } = createHookBash({
			files: { "/origin/README.md": "# hi" },
			cwd: "/origin",
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');

		let preTarget = "";
		let postBranch: string | null = null;
		git.on("pre-clone", (event) => {
			preTarget = event.targetPath;
		});
		git.on("post-clone", (event) => {
			postBranch = event.branch;
		});

		const result = await bash.exec("git clone /origin /copy", { cwd: "/" });
		expect(result.exitCode).toBe(0);
		expect(preTarget).toBe("/copy");
		expect(postBranch as unknown as string).toBe("main");
	});

	test("fetch emits pre-fetch and can abort", async () => {
		const { bash, git } = createHookBash({
			files: { "/remote/README.md": "# hello" },
			cwd: "/remote",
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');
		await bash.exec("git clone /remote /local", { cwd: "/" });

		let seenRemote = "";
		git.on("pre-fetch", (event) => {
			seenRemote = event.remote;
			return { abort: true, message: "no fetch" };
		});

		const result = await bash.exec("git fetch origin", { cwd: "/local" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("no fetch");
		expect(seenRemote).toBe("origin");
	});

	test("reset emits pre/post reset", async () => {
		const { bash, git } = createHookBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');
		await bash.exec("echo 'x' >> /repo/README.md");

		let mode = "";
		let targetHash = "";
		git.on("pre-reset", (event) => {
			mode = event.mode;
		});
		git.on("post-reset", (event) => {
			targetHash = event.targetHash ?? "";
		});

		const result = await bash.exec("git reset --hard HEAD");
		expect(result.exitCode).toBe(0);
		expect(mode).toBe("hard");
		expect(targetHash).toHaveLength(40);
	});

	test("clean/rm/stash/cherry-pick pre hooks can abort", async () => {
		const { bash, git } = createHookBash({ files: BASIC_REPO });
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

		git.on("pre-clean", () => ({ abort: true, message: "stop clean" }));
		git.on("pre-rm", () => ({ abort: true, message: "stop rm" }));
		git.on("pre-stash", () => ({ abort: true, message: "stop stash" }));
		git.on("pre-cherry-pick", () => ({
			abort: true,
			message: "stop cherry-pick",
		}));

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
