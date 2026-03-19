import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createSandbox, jg, justBash, realGit, removeSandbox, writeToSandbox } from "./util";

describe("interop: config cross-reading", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("real git sets config, just-git reads it", async () => {
		await realGit(sandbox, "config user.name 'Real Author'");
		await realGit(sandbox, "config user.email 'real@author.com'");
		await realGit(sandbox, "config core.autocrlf false");
		await realGit(sandbox, "config custom.mykey myvalue");

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

		const r1 = await realGit(sandbox, "config --get jg.testkey");
		expect(r1.exitCode).toBe(0);
		expect(r1.stdout.trim()).toBe("testvalue");

		const r2 = await realGit(sandbox, "config --get jg.number");
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
		await realGit(sandbox, "config merge.ff only");
		await realGit(sandbox, "config branch.main.remote origin");
		await realGit(sandbox, "config branch.main.merge refs/heads/main");

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

		const r1 = await realGit(sandbox, "config --get merge.ff");
		expect(r1.exitCode).toBe(0);

		const r2 = await realGit(sandbox, "config --get branch.main.remote");
		expect(r2.exitCode).toBe(0);

		const r3 = await realGit(sandbox, "config --get alias.co");
		expect(r3.exitCode).toBe(0);
		expect(r3.stdout.trim()).toBe("checkout");
	});

	test("config survives multiple interleaved writes", async () => {
		await realGit(sandbox, "config real.key1 val1");
		const b1 = justBash(sandbox);
		await jg(b1, "git config set jg.key1 jval1");
		await realGit(sandbox, "config real.key2 val2");
		const b2 = justBash(sandbox);
		await jg(b2, "git config set jg.key2 jval2");
		await realGit(sandbox, "config real.key3 val3");

		const r1 = await realGit(sandbox, "config --get real.key1");
		expect(r1.stdout.trim()).toBe("val1");
		const r2 = await realGit(sandbox, "config --get jg.key1");
		expect(r2.stdout.trim()).toBe("jval1");
		const r3 = await realGit(sandbox, "config --get real.key3");
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
		await realGit(sandbox, "config test.key1 value1");
		await realGit(sandbox, "config test.key2 value2");
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git unsets config, real git confirms", async () => {
		const b = justBash(sandbox);
		const r = await jg(b, "git config unset test.key1");
		expect(r.exitCode).toBe(0);

		const check = await realGit(sandbox, "config --get test.key1");
		expect(check.exitCode).not.toBe(0);

		const check2 = await realGit(sandbox, "config --get test.key2");
		expect(check2.stdout.trim()).toBe("value2");
	});

	test("real git unsets config, just-git confirms", async () => {
		await realGit(sandbox, "config --unset test.key2");

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
		await realGit(sandbox, "config branch.main.remote origin");
		await realGit(sandbox, "config branch.main.merge refs/heads/main");

		const b = justBash(sandbox);
		const r = await jg(b, "git config get branch.main.remote");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("origin");
	});

	test("just-git sets branch tracking, real git reads", async () => {
		const b = justBash(sandbox);
		await jg(b, "git config set branch.main.rebase true");

		const r = await realGit(sandbox, "config --get branch.main.rebase");
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
		await realGit(sandbox, "config user.name 'First Middle Last'");
		const b = justBash(sandbox);
		const r = await jg(b, "git config get user.name");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("First Middle Last");
	});

	test("config value with special characters", async () => {
		await realGit(sandbox, "config test.url 'https://example.com/path?q=1&b=2'");
		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.url");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("https://example.com/path?q=1&b=2");
	});

	test("config value with equals sign", async () => {
		await realGit(sandbox, "config test.expr 'a=b=c'");
		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.expr");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("a=b=c");
	});

	test("boolean config values", async () => {
		await realGit(sandbox, "config core.bare false");
		await realGit(sandbox, "config core.ignorecase true");

		const b = justBash(sandbox);
		const r1 = await jg(b, "git config get core.bare");
		expect(r1.exitCode).toBe(0);
		expect(r1.stdout.trim()).toBe("false");

		const r2 = await jg(b, "git config get core.ignorecase");
		expect(r2.exitCode).toBe(0);
		expect(r2.stdout.trim()).toBe("true");
	});
});

describe("interop: quoted values and escapes", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("value with hash character (real git quotes it)", async () => {
		await realGit(sandbox, "config test.hash 'value # with hash'");
		const raw = readFileSync(join(sandbox, ".git/config"), "utf8");
		expect(raw).toContain("value");

		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.hash");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("value # with hash");
	});

	test("value with semicolon character", async () => {
		await realGit(sandbox, "config test.semi 'value ; with semi'");

		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.semi");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("value ; with semi");
	});

	test("value with leading whitespace (real git quotes it)", async () => {
		await realGit(sandbox, "config test.leading '  leading spaces'");

		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.leading");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("  leading spaces\n");
	});

	test("value with trailing whitespace (real git quotes it)", async () => {
		await realGit(sandbox, "config test.trailing 'trailing spaces  '");

		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.trailing");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("trailing spaces  \n");
	});

	test("value with backslash (real git escapes it)", async () => {
		await realGit(sandbox, "config test.bslash 'C:\\Users\\me'");

		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.bslash");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("C:\\Users\\me");
	});

	test("value with double quotes (real git escapes them)", async () => {
		await realGit(sandbox, `config test.dquote 'say "hello"'`);

		const b = justBash(sandbox);
		const r = await jg(b, "git config get test.dquote");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe('say "hello"');
	});

	test("hand-crafted config with inline comment", async () => {
		const configPath = join(sandbox, ".git/config");
		const existing = readFileSync(configPath, "utf8");
		writeFileSync(
			configPath,
			`${existing}[manual]\n\tkey1 = value1 # this is a comment\n\tkey2 = value2 ; another comment\n`,
		);

		const b = justBash(sandbox);
		const r1 = await jg(b, "git config get manual.key1");
		expect(r1.exitCode).toBe(0);
		expect(r1.stdout.trim()).toBe("value1");

		const r2 = await jg(b, "git config get manual.key2");
		expect(r2.exitCode).toBe(0);
		expect(r2.stdout.trim()).toBe("value2");

		const rr1 = await realGit(sandbox, "config --get manual.key1");
		expect(rr1.stdout.trim()).toBe("value1");
	});

	test("hand-crafted config with continuation line", async () => {
		const configPath = join(sandbox, ".git/config");
		const existing = readFileSync(configPath, "utf8");
		writeFileSync(configPath, `${existing}[multi]\n\tline = hello \\\nworld\n`);

		const b = justBash(sandbox);
		const r = await jg(b, "git config get multi.line");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("hello world");

		const rr = await realGit(sandbox, "config --get multi.line");
		expect(rr.stdout.trim()).toBe("hello world");
	});

	test("hand-crafted config with escape sequences", async () => {
		const configPath = join(sandbox, ".git/config");
		const existing = readFileSync(configPath, "utf8");
		writeFileSync(
			configPath,
			`${existing}[esc]\n\ttabs = "col1\\tcol2"\n\tnewlines = "line1\\nline2"\n\tbackslash = path\\\\dir\n`,
		);

		const b = justBash(sandbox);

		const r1 = await jg(b, "git config get esc.tabs");
		expect(r1.exitCode).toBe(0);
		expect(r1.stdout.trim()).toBe("col1\tcol2");

		const r2 = await jg(b, "git config get esc.newlines");
		expect(r2.exitCode).toBe(0);
		expect(r2.stdout).toContain("line1\nline2");

		const r3 = await jg(b, "git config get esc.backslash");
		expect(r3.exitCode).toBe(0);
		expect(r3.stdout.trim()).toBe("path\\dir");

		const rr1 = await realGit(sandbox, "config --get esc.tabs");
		expect(rr1.stdout.trim()).toBe("col1\tcol2");

		const rr3 = await realGit(sandbox, "config --get esc.backslash");
		expect(rr3.stdout.trim()).toBe("path\\dir");
	});
});

describe("interop: format-preserving writes", () => {
	let sandbox: string;
	beforeAll(async () => {
		sandbox = createSandbox();
		await $`git -c init.defaultBranch=main init`.cwd(sandbox).quiet();
	});
	afterAll(() => removeSandbox(sandbox));

	test("just-git set preserves comments written by real git or user", async () => {
		const configPath = join(sandbox, ".git/config");
		const existing = readFileSync(configPath, "utf8");
		writeFileSync(
			configPath,
			`${existing}# My custom comment\n[myapp]\n\t# key1 docs\n\tkey1 = original\n; footer comment\n`,
		);

		const b = justBash(sandbox);
		await jg(b, "git config set myapp.key2 added");

		const raw = readFileSync(configPath, "utf8");
		expect(raw).toContain("# My custom comment");
		expect(raw).toContain("# key1 docs");
		expect(raw).toContain("; footer comment");
		expect(raw).toContain("key1 = original");
		expect(raw).toContain("key2 = added");
	});

	test("just-git set preserves real git's existing values", async () => {
		await realGit(sandbox, "config core.editor vim");
		await realGit(sandbox, "config myapp.author 'Real Author'");

		const b = justBash(sandbox);
		await jg(b, "git config set myapp.version 2");

		const rEditor = await realGit(sandbox, "config --get core.editor");
		expect(rEditor.stdout.trim()).toBe("vim");

		const rAuthor = await realGit(sandbox, "config --get myapp.author");
		expect(rAuthor.stdout.trim()).toBe("Real Author");

		const rVersion = await realGit(sandbox, "config --get myapp.version");
		expect(rVersion.stdout.trim()).toBe("2");
	});

	test("just-git unset preserves other entries", async () => {
		await realGit(sandbox, "config test.keep keepme");
		await realGit(sandbox, "config test.remove removeme");

		const configBefore = readFileSync(join(sandbox, ".git/config"), "utf8");
		expect(configBefore).toContain("keep");
		expect(configBefore).toContain("remove");

		const b = justBash(sandbox);
		await jg(b, "git config unset test.remove");

		const rKeep = await realGit(sandbox, "config --get test.keep");
		expect(rKeep.stdout.trim()).toBe("keepme");

		const rRemove = await realGit(sandbox, "config --get test.remove");
		expect(rRemove.exitCode).not.toBe(0);
	});

	test("just-git write produces values real git can read", async () => {
		const configPath = join(sandbox, ".git/config");
		const existing = readFileSync(configPath, "utf8");
		const { setConfigValueRaw } = await import("../../src/lib/config.ts");
		const updated = setConfigValueRaw(existing, "test", "bslash", "C:\\path\\to");
		writeFileSync(configPath, updated);

		const r = await realGit(sandbox, "config --get test.bslash");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("C:\\path\\to");

		const b = justBash(sandbox);
		const r2 = await jg(b, "git config get test.bslash");
		expect(r2.stdout.trim()).toBe("C:\\path\\to");
	});
});
