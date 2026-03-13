import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { $ } from "bun";
import {
	createSandbox,
	jg,
	justBash,
	realGit,
	removeSandbox,
	writeToSandbox,
} from "./util";

// ── Packfiles ───────────────────────────────────────────────────────

describe("interop: real git gc → just-git reads", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git init`.cwd(sandbox).quiet();
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(sandbox, "file.txt"), `version ${i}\n`);
			await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
			await $`git -c user.name="R" -c user.email="r@t" commit -m ${"commit " + i}`
				.cwd(sandbox)
				.quiet();
		}
		await $`git gc --aggressive`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git log after real git gc", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git log --oneline");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(10);
	});

	test("just-git show HEAD after gc", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git show HEAD");
		expect(r.exitCode).toBe(0);
	});

	test("just-git diff HEAD~3..HEAD after gc", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git diff HEAD~3..HEAD");
		expect(r.exitCode).toBe(0);
	});

	test("just-git blame after gc", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git blame file.txt");
		expect(r.exitCode).toBe(0);
	});

	test("just-git commit on top of packed repo", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "new line" >> file.txt');
		await jg(b, "git add .");
		const r = await jg(b, 'git commit -m "just-git on packed repo"');
		expect(r.exitCode).toBe(0);

		const r2 = await realGit(sandbox, "log --oneline -3");
		expect(r2.stdout).toContain("just-git on packed repo");
	});

	test("real git fsck after just-git commit on packed repo", async () => {
		const r = await realGit(sandbox, "fsck --full");
		expect(r.exitCode).toBe(0);
	});
});

describe("interop: just-git gc → real git reads", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		const b = justBash(sandbox);
		await jg(b, "git init");
		for (let i = 0; i < 10; i++) {
			await jg(b, `echo "v${i}" > file.txt`);
			await jg(b, "git add .");
			await jg(b, `git commit -m "jg commit ${i}"`);
		}
		await jg(b, "git gc --aggressive");
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git log after just-git gc", async () => {
		const r = await realGit(sandbox, "log --oneline");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(10);
	});

	test("real git fsck after just-git gc", async () => {
		const r = await realGit(sandbox, "fsck --full");
		expect(r.exitCode).toBe(0);
	});

	test("real git show after just-git gc", async () => {
		const r = await realGit(sandbox, "show HEAD");
		expect(r.exitCode).toBe(0);
	});
});

// ── Reflog ──────────────────────────────────────────────────────────

describe("interop: reflog", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git init`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "f.txt", "a\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "real commit 1"`
			.cwd(sandbox)
			.quiet();
		writeToSandbox(sandbox, "f.txt", "b\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "real commit 2"`
			.cwd(sandbox)
			.quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git reads real git reflog", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git reflog");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("real commit 2");
	});

	test("just-git commits produce reflog entries readable by real git", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "c" > f.txt');
		await jg(b, "git add .");
		await jg(b, 'git commit -m "jg reflog commit"');

		const r = await realGit(sandbox, "reflog");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("jg reflog commit");
	});
});

// ── Index format ────────────────────────────────────────────────────

describe("interop: index format compatibility", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git init`.cwd(sandbox).quiet();
		await $`bash -c 'echo a > a.txt && echo b > b.txt && echo c > c.txt'`
			.cwd(sandbox)
			.quiet();
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git status reads real git index", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git status -s");
		expect(r.exitCode).toBe(0);
	});

	test("just-git ls-files reads real git index", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git ls-files --cached");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("a.txt");
	});

	test("just-git add + commit, real git status clean", async () => {
		await $`git -c user.name="R" -c user.email="r@t" commit -m "index test"`.cwd(sandbox).quiet();

		const b = justBash(sandbox);
		await jg(b, 'echo "new" > new.txt');
		await jg(b, "git add new.txt");
		await jg(b, 'git commit -m "jg index commit"');

		const r = await realGit(sandbox, "status --porcelain");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("");
	});

	test("real git reads just-git staged files before commit", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "staged" > staged.txt');
		await jg(b, "git add staged.txt");

		const r = await realGit(sandbox, "status --porcelain");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("staged.txt");
	});
});

// ── Binary files ────────────────────────────────────────────────────

describe("interop: binary files", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git init`.cwd(sandbox).quiet();
		const binaryData = new Uint8Array(1024);
		for (let i = 0; i < binaryData.length; i++) binaryData[i] = i % 256;
		writeFileSync(join(sandbox, "binary.bin"), binaryData);
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "add binary"`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git status with binary file", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git status");
		expect(r.exitCode).toBe(0);
	});

	test("just-git log with binary file", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git log --oneline");
		expect(r.exitCode).toBe(0);
	});

	test("just-git diff of modified binary", async () => {
		const modified = new Uint8Array(1024);
		for (let i = 0; i < modified.length; i++) modified[i] = (i + 1) % 256;
		writeFileSync(join(sandbox, "binary.bin"), modified);

		const b = justBash(sandbox);
		const r = await jg(b, "git diff");
		expect(r.exitCode).toBe(0);
	});
});

// ── Merge conflicts ─────────────────────────────────────────────────

describe("interop: cross-tool merge conflict", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git init`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "conflict.txt", "base\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "base"`.cwd(sandbox).quiet();

		await $`git checkout -b branch-a`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "conflict.txt", "from branch a\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "branch a change"`
			.cwd(sandbox)
			.quiet();

		await $`git checkout main`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "conflict.txt", "from main\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "main change"`
			.cwd(sandbox)
			.quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git merge detects conflict from real git branches", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git merge branch-a");
		expect(r.exitCode).not.toBe(0);
		expect(r.stdout).toContain("CONFLICT");
	});

	test("just-git resolves conflict, real git validates with fsck", async () => {
		const b = justBash(sandbox);
		await jg(b, "git merge branch-a");
		await jg(b, 'echo "resolved" > conflict.txt');
		await jg(b, "git add .");
		const r = await jg(b, "git merge --continue");
		expect(r.exitCode).toBe(0);

		const fsck = await realGit(sandbox, "fsck --full");
		expect(fsck.exitCode).toBe(0);
	});
});

// ── Rebase ──────────────────────────────────────────────────────────

describe("interop: rebase", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git init`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "f.txt", "base\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "base"`.cwd(sandbox).quiet();
		await $`git checkout -b topic`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "t.txt", "topic1\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "topic 1"`.cwd(sandbox).quiet();
		await $`bash -c 'echo "topic2" >> t.txt'`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "topic 2"`.cwd(sandbox).quiet();
		await $`git checkout main`.cwd(sandbox).quiet();
		await $`bash -c 'echo "main2" >> f.txt'`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "main advance"`
			.cwd(sandbox)
			.quiet();
		await $`git checkout topic`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git rebase on real git repo", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git rebase main");
		expect(r.exitCode).toBe(0);

		const log = await jg(b, "git log --oneline");
		expect(log.stdout).toContain("topic 1");
		expect(log.stdout).toContain("main advance");
	});

	test("real git fsck after just-git rebase", async () => {
		const r = await realGit(sandbox, "fsck --full");
		expect(r.exitCode).toBe(0);
	});

	test("real git log after just-git rebase", async () => {
		const r = await realGit(sandbox, "log --oneline --all");
		expect(r.exitCode).toBe(0);
	});
});

// ── Cherry-pick ─────────────────────────────────────────────────────

describe("interop: cherry-pick", () => {
	test("just-git cherry-picks from real git branch, fsck passes", async () => {
		const sandbox = createSandbox();
		try {
			await $`git init`.cwd(sandbox).quiet();
			writeToSandbox(sandbox, "f.txt", "base\n");
			await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
			await $`git -c user.name="R" -c user.email="r@t" commit -m "base"`.cwd(sandbox).quiet();
			await $`git checkout -b pick-src`.cwd(sandbox).quiet();
			writeToSandbox(sandbox, "cherry.txt", "cherry\n");
			await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
			await $`git -c user.name="R" -c user.email="r@t" commit -m "the cherry"`
				.cwd(sandbox)
				.quiet();
			const cherryHash = (await $`git rev-parse HEAD`.cwd(sandbox).quiet()).stdout
				.toString()
				.trim();
			await $`git checkout main`.cwd(sandbox).quiet();

			const b = justBash(sandbox);
			const r = await jg(b, `git cherry-pick ${cherryHash}`);
			expect(r.exitCode).toBe(0);

			const fsck = await realGit(sandbox, "fsck --full");
			expect(fsck.exitCode).toBe(0);
		} finally {
			removeSandbox(sandbox);
		}
	});
});

// ── Stash ───────────────────────────────────────────────────────────

describe("interop: stash — both directions", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git init`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "f.txt", "base\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "base"`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git stash, just-git stash list sees it", async () => {
		await $`bash -c 'echo "dirty" >> f.txt'`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" stash push -m "real stash"`
			.cwd(sandbox)
			.quiet();

		const b = justBash(sandbox);
		const r = await jg(b, "git stash list");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("real stash");
	});

	test("just-git stash pop from real git stash", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git stash pop");
		expect(r.exitCode).toBe(0);
	});

	test("just-git stash push, real git stash list sees it", async () => {
		const b = justBash(sandbox);
		await jg(b, 'echo "jg dirty" >> f.txt');
		await jg(b, "git stash push -m 'jg stash'");

		const r = await realGit(sandbox, "stash list");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("jg stash");
	});

	test("real git stash pop from just-git stash", async () => {
		const r = await realGit(sandbox, "stash pop");
		expect(r.exitCode).toBe(0);
	});
});

// ── .gitignore ──────────────────────────────────────────────────────

describe("interop: .gitignore", () => {
	test("just-git respects .gitignore from real repo", async () => {
		const sandbox = createSandbox();
		try {
			await $`git init`.cwd(sandbox).quiet();
			writeToSandbox(sandbox, ".gitignore", "node_modules/\n");
			writeToSandbox(sandbox, "node_modules/pkg.js", "pkg\n");
			writeToSandbox(sandbox, "app.js", "app\n");
			await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
			await $`git -c user.name="R" -c user.email="r@t" commit -m "with gitignore"`
				.cwd(sandbox)
				.quiet();

			const b = justBash(sandbox);
			await jg(b, 'echo "new" > new.js');
			await jg(b, 'echo "ignored" > node_modules/ignored.js');
			const r = await jg(b, "git status -s");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).not.toContain("node_modules");
			expect(r.stdout).toContain("new.js");
		} finally {
			removeSandbox(sandbox);
		}
	});
});

// ── Detached HEAD ───────────────────────────────────────────────────

describe("interop: detached HEAD", () => {
	let sandbox: string;
	let v1Hash: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git init`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "f.txt", "v1\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "v1"`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "f.txt", "v2\n");
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "v2"`.cwd(sandbox).quiet();
		v1Hash = (await $`git rev-parse HEAD~1`.cwd(sandbox).quiet()).stdout.toString().trim();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git detach HEAD on real repo", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, `git checkout ${v1Hash}`);
		expect(r.exitCode).toBe(0);

		const head = readFileSync(join(sandbox, ".git/HEAD"), "utf-8").trim();
		expect(head.startsWith("ref:")).toBe(false);
	});

	test("real git confirms detached state", async () => {
		const r = await realGit(sandbox, "status");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("detached");
	});
});

// ── Many files / deep paths ─────────────────────────────────────────

describe("interop: many files / deep paths", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git init`.cwd(sandbox).quiet();
		for (let i = 0; i < 50; i++) {
			const dir = `src/pkg${Math.floor(i / 10)}`;
			await $`mkdir -p ${dir}`.cwd(sandbox).quiet();
			writeFileSync(join(sandbox, dir, `file${i}.ts`), `export const x${i} = ${i};\n`);
		}
		await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
		await $`git -c user.name="R" -c user.email="r@t" commit -m "50 files"`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git ls-files on 50-file real repo", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git ls-files");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(50);
	});

	test("just-git add + commit new files, fsck passes", async () => {
		const b = justBash(sandbox);
		for (let i = 50; i < 55; i++) {
			await jg(b, `echo "new${i}" > src/pkg0/new${i}.ts`);
		}
		await jg(b, "git add .");
		const r = await jg(b, 'git commit -m "add 5 more"');
		expect(r.exitCode).toBe(0);

		const fsck = await realGit(sandbox, "fsck --full");
		expect(fsck.exitCode).toBe(0);
	});
});

// ── Reset ───────────────────────────────────────────────────────────

describe("interop: reset", () => {
	test("reset --soft HEAD~1, both tools agree on staged state", async () => {
		const sandbox = createSandbox();
		try {
			await $`git init`.cwd(sandbox).quiet();
			writeToSandbox(sandbox, "a.txt", "a\n");
			await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
			await $`git -c user.name="R" -c user.email="r@t" commit -m "commit a"`
				.cwd(sandbox)
				.quiet();
			writeToSandbox(sandbox, "b.txt", "b\n");
			await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
			await $`git -c user.name="R" -c user.email="r@t" commit -m "commit b"`
				.cwd(sandbox)
				.quiet();

			const b = justBash(sandbox);
			const r = await jg(b, "git reset --soft HEAD~1");
			expect(r.exitCode).toBe(0);

			const st = await jg(b, "git status -s");
			expect(st.stdout).toContain("b.txt");

			const realSt = await realGit(sandbox, "status --porcelain");
			expect(realSt.stdout).toContain("b.txt");
		} finally {
			removeSandbox(sandbox);
		}
	});

	test("reset --hard HEAD~1, real git validates", async () => {
		const sandbox = createSandbox();
		try {
			await $`git init`.cwd(sandbox).quiet();
			writeToSandbox(sandbox, "a.txt", "a\n");
			await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
			await $`git -c user.name="R" -c user.email="r@t" commit -m "commit a"`
				.cwd(sandbox)
				.quiet();
			writeToSandbox(sandbox, "b.txt", "b\n");
			await $`git -c user.name="R" -c user.email="r@t" add .`.cwd(sandbox).quiet();
			await $`git -c user.name="R" -c user.email="r@t" commit -m "commit b"`
				.cwd(sandbox)
				.quiet();

			const b = justBash(sandbox);
			const r = await jg(b, "git reset --hard HEAD~1");
			expect(r.exitCode).toBe(0);

			const realLog = await realGit(sandbox, "log --oneline");
			expect(realLog.stdout).not.toContain("commit b");

			const realSt = await realGit(sandbox, "status --porcelain");
			expect(realSt.stdout.trim()).toBe("");
		} finally {
			removeSandbox(sandbox);
		}
	});
});
