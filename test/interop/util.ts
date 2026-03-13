import { Bash, ReadWriteFs } from "just-bash";
import { createGit } from "../../src/git";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

/** Create a fresh temp directory for a test group. */
export function createSandbox(): string {
	return mkdtempSync(join(tmpdir(), "just-git-interop-"));
}

/** Remove a sandbox directory. */
export function removeSandbox(path: string): void {
	if (!path) return;
	rmSync(path, { recursive: true, force: true });
}

/** Create a just-bash instance with just-git registered, backed by real disk at the sandbox path. */
export function justBash(sandbox: string) {
	const rwfs = new ReadWriteFs({ root: sandbox });
	const git = createGit({
		identity: { name: "JustGit User", email: "justgit@test.com" },
	});
	return new Bash({ fs: rwfs, cwd: "/", customCommands: [git] });
}

/** Run a command through the just-bash+just-git instance. */
export async function jg(bash: Bash, cmd: string) {
	return bash.exec(cmd);
}

/**
 * Run a real git command in the sandbox directory.
 * Identity is always provided via -c flags to avoid depending on global config.
 */
export async function realGit(sandbox: string, cmd: string) {
	const r = await $`git -c user.name="Real Git" -c user.email="real@test.com" ${{ raw: cmd }}`
		.cwd(sandbox)
		.nothrow()
		.quiet();
	return {
		stdout: r.stdout.toString(),
		stderr: r.stderr.toString(),
		exitCode: r.exitCode,
	};
}

/** Write a file to the sandbox directory at the given relative path. */
export function writeToSandbox(sandbox: string, relPath: string, content: string | Uint8Array) {
	const full = join(sandbox, relPath);
	const dir = full.substring(0, full.lastIndexOf("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(full, content);
}
