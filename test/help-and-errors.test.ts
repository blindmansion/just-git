import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash";
import { createGit, VERSION } from "../src/git";

const git = createGit({ identity: { name: "Test", email: "test@test.com" } });
const fs = new InMemoryFs();

// ── git version / --version ─────────────────────────────────────────

describe("version", () => {
	test("git version prints version string", async () => {
		const r = await git.exec("version", { fs, cwd: "/" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe(`just-git version ${VERSION} (virtual git implementation)\n`);
		expect(r.stderr).toBe("");
	});

	test("git --version prints version string", async () => {
		const r = await git.exec("--version", { fs, cwd: "/" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe(`just-git version ${VERSION} (virtual git implementation)\n`);
		expect(r.stderr).toBe("");
	});

	test("VERSION constant matches package.json", async () => {
		const pkg = await import("../package.json");
		expect(VERSION).toBe(pkg.default.version);
	});
});

// ── git help ────────────────────────────────────────────────────────

describe("help command", () => {
	test("git help shows top-level help", async () => {
		const r = await git.exec("help", { fs, cwd: "/" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("Commands:");
		expect(r.stdout).toContain("init");
		expect(r.stdout).toContain("commit");
	});

	test("git help commit shows commit help", async () => {
		const r = await git.exec("help commit", { fs, cwd: "/" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("git commit");
		expect(r.stdout).toContain("-m");
	});

	test("git help init shows init help", async () => {
		const r = await git.exec("help init", { fs, cwd: "/" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("git init");
	});

	test("git help for unknown command reports no help available", async () => {
		const r = await git.exec("help frobnicate", { fs, cwd: "/" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("no help available for 'frobnicate'");
	});

	test("git --help shows top-level help", async () => {
		const r = await git.exec("--help", { fs, cwd: "/" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("Commands:");
	});

	test("git commit --help shows commit help", async () => {
		const r = await git.exec("commit --help", { fs, cwd: "/" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("git commit");
	});
});

// ── unknown command + --help ────────────────────────────────────────

describe("unknown command with --help", () => {
	test("git frobnicate --help reports unknown command, not help", async () => {
		const r = await git.exec("frobnicate --help", { fs, cwd: "/" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("frobnicate");
		expect(r.stdout).toBe("");
	});

	test("git comit --help suggests commit", async () => {
		const r = await git.exec("comit --help", { fs, cwd: "/" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("'comit' is not a git command");
		expect(r.stderr).toContain("commit");
	});
});

// ── unimplemented git commands ──────────────────────────────────────

describe("unimplemented commands", () => {
	test("git shortlog reports not implemented", async () => {
		const r = await git.exec("shortlog", { fs, cwd: "/" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("'shortlog' is not implemented");
		expect(r.stderr).toContain("git help");
	});

	test("git describe reports not implemented", async () => {
		const r = await git.exec("describe", { fs, cwd: "/" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("'describe' is not implemented");
	});

	test("git submodule reports not implemented", async () => {
		const r = await git.exec("submodule", { fs, cwd: "/" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("'submodule' is not implemented");
	});

	test("unimplemented error differs from truly unknown command", async () => {
		const unimpl = await git.exec("shortlog", { fs, cwd: "/" });
		const unknown = await git.exec("frobnicate", { fs, cwd: "/" });

		expect(unimpl.stderr).toContain("is not implemented");
		expect(unknown.stderr).not.toContain("is not implemented");
		expect(unknown.stderr).toContain("is not a git command");
	});

	test("git worktree reports not implemented (not unknown command)", async () => {
		const r = await git.exec("worktree list", { fs, cwd: "/" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("'worktree' is not implemented");
		expect(r.stderr).toContain("git help");
	});

	test("disabled check takes priority over unimplemented", async () => {
		const restricted = createGit({
			identity: { name: "Test", email: "test@test.com" },
			disabled: ["shortlog" as any],
		});
		const r = await restricted.exec("shortlog", { fs, cwd: "/" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("not available in this environment");
	});
});

// ── unknown options ─────────────────────────────────────────────────

describe("unknown options", () => {
	test("unknown option includes subset note", async () => {
		await git.exec("init", { fs, cwd: "/opt-test" });
		const r = await git.exec("log --merges", { fs, cwd: "/opt-test" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Unknown option");
		expect(r.stderr).toContain("Not all git options are supported");
	});
});

// ── bare git invocation ─────────────────────────────────────────────

describe("bare invocation", () => {
	test("bare git (no args) shows help", async () => {
		const r = await git.exec("git", { fs, cwd: "/" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("Commands:");
	});
});
