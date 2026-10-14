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

/**
 * Build a history whose commits exercise every `--summary` line, newest
 * first:
 *
 * - `merge side`: a merge that brings in `s`
 * - `content only`: modifies `keep`, so it has no summary lines
 * - `typechange`: `n` becomes a symlink, `dir/sub/b` moves to `x/y/b`
 * - `more`: renames `dir/sub/a`, adds a symlink and oddly named files
 * - `modes`: renames and shrinks `big` while making it executable, and
 *   makes `n` executable
 * - `sum`: deletes executable `m`, adds `n`, renames `z` to `z2`
 * - `init`
 *
 * `side` branches from `typechange` and adds `s`.
 */
export async function setupSummaryHistory(): Promise<Bash> {
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\n`).join("");
	const bash = createTestBash({
		files: {
			"/repo/m": "m\n",
			"/repo/z": "z\n",
			"/repo/big": lines(20),
			"/repo/keep": "keep\n",
			"/repo/dir/sub/a": "a\n",
		},
		env: TEST_ENV,
	});
	const run = async (...commands: string[]) => {
		for (const command of commands) {
			const result = await bash.exec(command);
			if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr}`);
		}
	};
	await run("git init -q", "chmod +x m", "git add .", "git commit -qm init");
	await bash.fs.writeFile("/repo/n", "n\n");
	await run("git rm -q m", "git add n", "git mv z z2", "git commit -qm sum");
	await bash.fs.writeFile("/repo/big", lines(15));
	await run("git mv big big2", "chmod +x big2 n", "git add -A", "git commit -qm modes");
	for (const name of ["sp ace", 'q"uote', "ta\tb", "é.txt"]) {
		await bash.fs.writeFile(`/repo/${name}`, "x\n");
	}
	await run("git mv dir/sub/a dir/sub/b", "ln -s n link", "git add -A", "git commit -qm more");
	await run(
		"rm n",
		"ln -s keep n",
		"mkdir -p x/y",
		"git mv dir/sub/b x/y/b",
		"git add -A",
		"git commit -qm typechange",
	);
	await run("git checkout -qb side", "echo s > s", "git add s", "git commit -qm side");
	await run("git checkout -q main", "echo more >> keep", "git commit -qam 'content only'");
	await run("git merge -q --no-ff -m 'merge side' side");
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
