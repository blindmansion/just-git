import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PATH = "/usr/bin:/bin:/usr/local/bin";

/**
 * Build an environment that isolates the real git binary from the developer's
 * global and system configuration.
 *
 * Global config is redirected to `/dev/null` and system config is disabled, so
 * a setting such as `commit.gpgsign` in the developer's `~/.gitconfig` cannot
 * leak into a test repository and change the objects git produces. Structural
 * defaults (`init.defaultBranch`, `gc.auto`) are pinned so behaviour does not
 * depend on the host git's version-specific defaults. Identity and any other
 * per-test variables should be supplied through `overrides`.
 */
export function isolatedGitEnv(
	home: string,
	overrides?: Record<string, string>,
): Record<string, string> {
	return {
		PATH: process.env.PATH ?? DEFAULT_PATH,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "init.defaultBranch",
		GIT_CONFIG_VALUE_0: "main",
		GIT_CONFIG_KEY_1: "gc.auto",
		GIT_CONFIG_VALUE_1: "0",
		GIT_EDITOR: "true",
		...overrides,
	};
}

export interface RealGitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export class GitCommandError extends Error {
	constructor(
		readonly args: string[],
		readonly result: RealGitResult,
	) {
		super(`git ${args.join(" ")} failed with exit code ${result.exitCode}`);
		this.name = "GitCommandError";
	}
}

/**
 * A sandbox for driving the real git binary from tests.
 *
 * Bundles a working directory, an isolated `HOME`, and the
 * {@link isolatedGitEnv} environment so call sites supply only the git
 * arguments. Because an instance cannot be obtained without that isolated
 * environment, a harness cannot accidentally run git against the developer's
 * own config.
 *
 * {@link exec} and {@link execAsync} take an argument vector and run `git` for
 * you — there is no shell, so no quoting concerns. {@link execShell} is an
 * escape hatch for harnesses (such as the graph oracle) whose commands arrive
 * as pre-formed shell strings.
 */
export class RealGit {
	private constructor(
		readonly cwd: string,
		readonly home: string,
		private readonly env: Record<string, string>,
		private readonly ownsDirs: boolean,
	) {}

	/**
	 * Create a sandbox backed by fresh temporary working and home directories.
	 * Call {@link cleanup} when finished to remove them.
	 */
	static create(options?: { env?: Record<string, string>; prefix?: string }): RealGit {
		const home = mkdtempSync(join(tmpdir(), "real-git-home-"));
		const cwd = mkdtempSync(join(tmpdir(), options?.prefix ?? "real-git-"));
		return new RealGit(cwd, home, isolatedGitEnv(home, options?.env), true);
	}

	/**
	 * Wrap an existing directory whose lifecycle the caller manages. `HOME` is
	 * isolated to that directory unless a separate `home` is given.
	 */
	static in(cwd: string, options?: { home?: string; env?: Record<string, string> }): RealGit {
		const home = options?.home ?? cwd;
		return new RealGit(cwd, home, isolatedGitEnv(home, options?.env), false);
	}

	private envWith(extraEnv?: Record<string, string>): Record<string, string> {
		return extraEnv ? { ...this.env, ...extraEnv } : this.env;
	}

	/** Run `git` with the given arguments synchronously. */
	exec(args: string[], extraEnv?: Record<string, string>): RealGitResult {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: this.cwd,
			env: this.envWith(extraEnv),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});

		return {
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
			exitCode: result.exitCode ?? 1,
		};
	}

	/** Run `git` with the given arguments asynchronously, capturing its output. */
	async execAsync(args: string[], extraEnv?: Record<string, string>): Promise<RealGitResult> {
		const proc = Bun.spawn(["git", ...args], {
			cwd: this.cwd,
			env: this.envWith(extraEnv),
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		const result = { stdout, stderr, exitCode };
		if (exitCode !== 0) throw new GitCommandError(args, result);

		return result;
	}

	/**
	 * Run a pre-formed shell command string synchronously. Prefer {@link exec}
	 * for hand-written call sites; this exists for harnesses whose commands are
	 * authored as shell strings.
	 */
	execShell(command: string, extraEnv?: Record<string, string>): RealGitResult {
		const result = Bun.spawnSync(["sh", "-c", command], {
			cwd: this.cwd,
			env: this.envWith(extraEnv),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});

		return {
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
			exitCode: result.exitCode ?? 1,
		};
	}

	/** Remove the temporary directories, if this sandbox owns them. */
	cleanup(): void {
		if (!this.ownsDirs) return;

		rmSync(this.cwd, { recursive: true, force: true });
		rmSync(this.home, { recursive: true, force: true });
	}
}
