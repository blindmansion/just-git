import { Bash, type BashExecResult, type BashOptions, type IFileSystem } from "just-bash";
import { createGitCommand } from "../src/commands/git";
import { TEST_ENV } from "./fixtures";

// ── Factory ──────────────────────────────────────────────────────────

/** Create a Bash instance with the git command pre-registered. */
export function createTestBash(options: Partial<BashOptions> = {}): Bash {
	const customCommands = [createGitCommand().toCommand(), ...(options.customCommands ?? [])];
	return new Bash({ cwd: "/repo", ...options, customCommands });
}

export function observeFsCalls(fs: IFileSystem): {
	readdirPaths: string[];
	lstatPaths: string[];
	readFileBufferPaths: string[];
} {
	const readdirPaths: string[] = [];
	const lstatPaths: string[] = [];
	const readFileBufferPaths: string[] = [];
	const readdir = fs.readdir.bind(fs);
	const lstat = fs.lstat.bind(fs);
	const readFileBuffer = fs.readFileBuffer.bind(fs);
	fs.readdir = async (path) => {
		readdirPaths.push(path);
		return readdir(path);
	};
	fs.lstat = async (path) => {
		lstatPaths.push(path);
		return lstat(path);
	};
	fs.readFileBuffer = async (path) => {
		readFileBufferPaths.push(path);
		return readFileBuffer(path);
	};
	return { readdirPaths, lstatPaths, readFileBufferPaths };
}

/** Shorthand: create a bash env, run a single command, return the result. */
export async function quickExec(
	command: string,
	options: Partial<BashOptions> = {},
): Promise<BashExecResult> {
	const bash = createTestBash(options);
	return bash.exec(command);
}

/**
 * Run a sequence of commands against a single Bash instance,
 * returning all results plus the bash instance for further inspection.
 */
export async function runScenario(
	commands: string[],
	options: Partial<BashOptions> = {},
): Promise<{ results: BashExecResult[]; bash: Bash }> {
	const bash = createTestBash(options);
	const results: BashExecResult[] = [];
	for (const cmd of commands) {
		results.push(await bash.exec(cmd));
	}
	return { results, bash };
}

/** Init a remote repo at /remote and clone it to /local. Returns the shared Bash instance. */
export async function setupClonePair(): Promise<Bash> {
	const bash = createTestBash({
		files: { "/remote/README.md": "# Hello" },
		env: TEST_ENV,
		cwd: "/remote",
	});
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "initial"');
	await bash.exec("git clone /remote /local", { cwd: "/" });
	return bash;
}

// ── Filesystem query helpers (for use with expect()) ─────────────────

/** Check if a path exists in the virtual filesystem. */
export async function pathExists(fs: IFileSystem, path: string): Promise<boolean> {
	return fs.exists(path);
}

/** Read file content from the virtual fs (returns undefined if missing). */
export async function readFile(fs: IFileSystem, path: string): Promise<string | undefined> {
	const exists = await fs.exists(path);
	if (!exists) return undefined;
	return fs.readFile(path);
}

/** Check if a path is a directory. */
export async function isDirectory(fs: IFileSystem, path: string): Promise<boolean> {
	const exists = await fs.exists(path);
	if (!exists) return false;
	const stat = await fs.stat(path);
	return stat.isDirectory;
}

/** Check if a path is a file. */
export async function isFile(fs: IFileSystem, path: string): Promise<boolean> {
	const exists = await fs.exists(path);
	if (!exists) return false;
	const stat = await fs.stat(path);
	return stat.isFile;
}

export async function setupExecBitRepo(): Promise<Bash> {
	const bash = createTestBash({
		files: { "/repo/run.sh": "#!/bin/sh\necho hi\n" },
		env: TEST_ENV,
	});
	await bash.exec("git init && chmod 755 run.sh && git add run.sh && git commit -m exec");
	await bash.exec(
		"git switch -c plain && chmod 644 run.sh && git add run.sh && git commit -m plain",
	);
	await bash.exec("git switch main");
	return bash;
}

export async function permissionBits(fs: IFileSystem, path: string): Promise<number> {
	return (await fs.stat(path)).mode & 0o777;
}
