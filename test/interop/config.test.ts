import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { createSandbox, jg, justBash, realGit, removeSandbox, writeToSandbox } from "./util";

describe("interop: config cross-reading", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git sets config, just-git reads it", async () => {
		await realGit(sandbox, "config set user.name 'Real Author'");
		await realGit(sandbox, "config set user.email 'real@author.com'");
		await realGit(sandbox, "config set core.autocrlf false");
		await realGit(sandbox, "config set custom.mykey myvalue");

		const b = justBash(sandbox);
		const r1 = await jg(b, "git config get user.name");
		expect(r1.exitCode).toBe(0);
		expect(r1.stdout.trim()).toBe("Real Author");

		const r2 = await jg(b, "git config get user.email");
		expect(r2.stdout.trim()).toBe("real@author.com");

		const r3 = await jg(b, "git config get core.autocrlf");
		expect(r3.exitCode).toBe(0);
		expect(r3.stdout.trim()).toBe("false");

		const r4 = await jg(b, "git config get custom.mykey");
		expect(r4.exitCode).toBe(0);
		expect(r4.stdout.trim()).toBe("myvalue");
	});

	test("just-git sets config, real git reads it", async () => {
		const b = justBash(sandbox);
		await jg(b, "git config set jg.testkey testvalue");
		await jg(b, "git config set jg.number 42");

		const r1 = await realGit(sandbox, "config get jg.testkey");
		expect(r1.exitCode).toBe(0);
		expect(r1.stdout.trim()).toBe("testvalue");

		const r2 = await realGit(sandbox, "config get jg.number");
		expect(r2.stdout.trim()).toBe("42");
	});

	test("just-git config --list includes real git entries", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git config --list");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("user.name=Real Author");
		expect(r.stdout).toContain("jg.testkey=testvalue");
	});

	test("real git config --list includes just-git entries", async () => {
		const r = await realGit(sandbox, "config --list --local");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("jg.testkey=testvalue");
	});
});

describe("interop: config file format preservation", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("raw config readable after real git writes subsections", async () => {
		await realGit(sandbox, "config set merge.ff only");
		await realGit(sandbox, "config set branch.main.remote origin");
		await realGit(sandbox, "config set branch.main.merge refs/heads/main");

		const b = justBash(sandbox);
		const r = await jg(b, "git config get merge.ff");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("only");

		const r2 = await jg(b, "git config get branch.main.remote");
		expect(r2.exitCode).toBe(0);
	});

	test("just-git writes don't corrupt real git's sections", async () => {
		const b = justBash(sandbox);
		await jg(b, "git config set alias.co checkout");

		const r1 = await realGit(sandbox, "config get merge.ff");
		expect(r1.exitCode).toBe(0);

		const r2 = await realGit(sandbox, "config get branch.main.remote");
		expect(r2.exitCode).toBe(0);

		const r3 = await realGit(sandbox, "config get alias.co");
		expect(r3.exitCode).toBe(0);
		expect(r3.stdout.trim()).toBe("checkout");
	});

	test("config survives multiple interleaved writes", async () => {
		await realGit(sandbox, "config set real.key1 val1");
		const b1 = justBash(sandbox);
		await jg(b1, "git config set jg.key1 jval1");
		await realGit(sandbox, "config set real.key2 val2");
		const b2 = justBash(sandbox);
		await jg(b2, "git config set jg.key2 jval2");
		await realGit(sandbox, "config set real.key3 val3");

		const r1 = await realGit(sandbox, "config get real.key1");
		expect(r1.stdout.trim()).toBe("val1");
		const r2 = await realGit(sandbox, "config get jg.key1");
		expect(r2.stdout.trim()).toBe("jval1");
		const r3 = await realGit(sandbox, "config get real.key3");
		expect(r3.stdout.trim()).toBe("val3");

		const b3 = justBash(sandbox);
		const r4 = await jg(b3, "git config get jg.key2");
		expect(r4.stdout.trim()).toBe("jval2");
	});
});

describe("interop: config unset", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
		await realGit(sandbox, "config set test.key1 value1");
		await realGit(sandbox, "config set test.key2 value2");
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git unsets config, real git confirms", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git config unset test.key1");
		expect(r.exitCode).toBe(0);

		const check = await realGit(sandbox, "config get test.key1");
		expect(check.exitCode).not.toBe(0);

		const check2 = await realGit(sandbox, "config get test.key2");
		expect(check2.stdout.trim()).toBe("value2");
	});

	test("real git unsets config, just-git confirms", async () => {
		await realGit(sandbox, "config unset test.key2");

		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.key2");
		expect(r.exitCode).not.toBe(0);
	});
});

describe("interop: config behavioral effects", () => {
	test("real git inits with custom branch name, just-git sees it", async () => {
		const sandbox = createSandbox();
		try {
			await $`git init --initial-branch=develop`.cwd(sandbox).quiet();
			writeToSandbox(sandbox, "x.txt", "x\n");
			await $`git -c user.name=R -c user.email=r@t add .`.cwd(sandbox).quiet();
			await $`git -c user.name=R -c user.email=r@t commit -m "on develop"`.cwd(sandbox).quiet();

			const b = justBash(sandbox);
			const r = await jg(b, "git branch -v");
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("develop");
		} finally {
			removeSandbox(sandbox);
		}
	});
});

describe("interop: subsection config (remotes, branches)", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
		writeToSandbox(sandbox, "x.txt", "x\n");
		await $`git -c user.name=R -c user.email=r@t add .`.cwd(sandbox).quiet();
		await $`git -c user.name=R -c user.email=r@t commit -m "init"`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git remote add, just-git reads", async () => {
		await realGit(sandbox, "remote add origin https://github.com/test/repo.git");

		const b = justBash(sandbox);
		const r = await jg(b, "git remote -v");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("origin");
		expect(r.stdout).toContain("github.com");
	});

	test("just-git remote add, real git reads", async () => {
		const b = justBash(sandbox);
		await jg(b, "git remote add upstream https://github.com/test/upstream.git");

		const r = await realGit(sandbox, "remote -v");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("upstream");
	});

	test("real git sets branch tracking, just-git reads", async () => {
		await realGit(sandbox, "config set branch.main.remote origin");
		await realGit(sandbox, "config set branch.main.merge refs/heads/main");

		const b = justBash(sandbox);
		const r = await jg(b, "git config get branch.main.remote");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("origin");
	});

	test("just-git sets branch tracking, real git reads", async () => {
		const b = justBash(sandbox);
		await jg(b, "git config set branch.main.rebase true");

		const r = await realGit(sandbox, "config get branch.main.rebase");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("true");
	});
});

describe("interop: edge-case config values", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("config value with spaces", async () => {
		await realGit(sandbox, "config set user.name 'First Middle Last'");
		const b = justBash(sandbox);
		const r = await jg(b, "git config get user.name");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("First Middle Last");
	});

	test("config value with special characters", async () => {
		await realGit(sandbox, "config set test.url 'https://example.com/path?q=1&b=2'");
		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.url");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("https://example.com/path?q=1&b=2");
	});

	test("config value with equals sign", async () => {
		await realGit(sandbox, "config set test.expr 'a=b=c'");
		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.expr");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("a=b=c");
	});

	test("boolean config values", async () => {
		await realGit(sandbox, "config set core.bare false");
		await realGit(sandbox, "config set core.ignorecase true");

		const b = justBash(sandbox);
		const r1 = await jg(b, "git config get core.bare");
		expect(r1.exitCode).toBe(0);
		expect(r1.stdout.trim()).toBe("false");

		const r2 = await jg(b, "git config get core.ignorecase");
		expect(r2.exitCode).toBe(0);
		expect(r2.stdout.trim()).toBe("true");
	});
});
