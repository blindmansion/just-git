#!/usr/bin/env bun
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { am, createTreeAccessor, readCommit } from "../src/repo/index.ts";
import { durableFileSystemFromNodeFs, findRepo } from "../src/index.ts";

const keep = process.argv.slice(2).includes("--keep");
if (process.argv.some((arg) => arg === "--help" || arg === "-h")) {
	console.log(`Usage: bun scripts/am-repo-smoke.ts [--keep]

Create a source and target repository with real git, generate a two-patch
mailbox in the source, and replay it into the target through repo.am().

By default the temporary repositories are removed. Pass --keep to inspect them.`);
	process.exit(0);
}

const root = await nodeFs.mkdtemp(join(tmpdir(), "just-git-am-"));
const sourcePath = join(root, "source");
const targetPath = join(root, "target");

try {
	await nodeFs.mkdir(sourcePath);
	await git(sourcePath, "init", "--initial-branch=main");
	await git(sourcePath, "config", "user.name", "Patch Author");
	await git(sourcePath, "config", "user.email", "author@example.com");

	await nodeFs.writeFile(join(sourcePath, "document.txt"), "Title\n\nBase paragraph.\n");
	await git(sourcePath, "add", "document.txt");
	await git(sourcePath, "commit", "-m", "base");
	const base = await git(sourcePath, "rev-parse", "HEAD");

	// Clone while source is still at the base commit. This gives the independent
	// target repository the same starting history without either repo sharing a
	// working tree, index, object directory, or refs.
	await run(["git", "clone", "--quiet", sourcePath, targetPath], root);

	await nodeFs.writeFile(
		join(sourcePath, "document.txt"),
		"Title\n\nParagraph edited in the first patch.\n",
	);
	await git(sourcePath, "add", "document.txt");
	await git(sourcePath, "commit", "-m", "edit document");

	await nodeFs.mkdir(join(sourcePath, "guides"));
	await nodeFs.writeFile(
		join(sourcePath, "guides", "usage.txt"),
		"Apply this series without invoking git am.\n",
	);
	await git(sourcePath, "add", "guides/usage.txt");
	await git(sourcePath, "commit", "-m", "add usage guide");
	const sourceHead = await git(sourcePath, "rev-parse", "HEAD");
	const mailbox = await git(
		sourcePath,
		"format-patch",
		"--stdout",
		"--no-signature",
		`${base}..HEAD`,
	);

	console.log(`Temporary root: ${root}`);
	console.log(`Source:         ${sourcePath}`);
	console.log(`Target:         ${targetPath}`);
	console.log(`Base:           ${shortHash(base)}`);
	console.log(`Source HEAD:    ${shortHash(sourceHead)}`);
	console.log(`Mailbox bytes:  ${Buffer.byteLength(mailbox)}\n`);

	const fs = durableFileSystemFromNodeFs(nodeFs);
	const repo = await findRepo(fs, targetPath);
	if (!repo) throw new Error(`Could not open target repository at ${targetPath}`);

	console.log("Calling repo.am() with a real git-generated mailbox:");
	console.log(`  onto:           "HEAD"`);
	console.log(`  branch:         "main"`);
	console.log(`  expectedOldHash: ${shortHash(base)}`);
	const result = await am(repo, {
		mbox: mailbox,
		onto: "HEAD",
		committer: { name: "Patch Integrator", email: "integrator@example.com" },
		branch: "main",
		expectedOldHash: base,
	});

	console.log(`\nResult: ${result.status}`);
	if (result.status !== "applied") {
		console.dir(result, { depth: 5 });
		throw new Error(`Expected the mailbox to apply, got ${result.status}`);
	}
	console.log(`Head:    ${result.head}`);
	console.log(`Commits: ${result.commits.map(shortHash).join(" -> ")}`);

	// Inspect the resulting commits through just-git before asking real git to
	// materialize the new HEAD into the deliberately untouched worktree/index.
	const headCommit = await readCommit(repo, result.head);
	const tree = createTreeAccessor(repo, headCommit.tree);
	console.log("\nFiles read from the resulting just-git tree:");
	console.log(`document.txt:    ${JSON.stringify(await tree.readFile("document.txt"))}`);
	console.log(`guides/usage.txt: ${JSON.stringify(await tree.readFile("guides/usage.txt"))}`);

	const gitHead = await git(targetPath, "rev-parse", "HEAD");
	if (gitHead !== result.head) throw new Error("Real git and just-git disagree on target HEAD");
	console.log(`\nReal git sees target HEAD at ${shortHash(gitHead)}.`);
	console.log("The repo API intentionally did not update the target worktree or index:");
	console.log((await git(targetPath, "status", "--short")) || "(clean)");

	await git(targetPath, "reset", "--hard", "HEAD");
	const subjects = await git(
		targetPath,
		"log",
		"--reverse",
		"--format=%h %s | author=%an | committer=%cn",
		`${base}..HEAD`,
	);
	console.log("\nAfter real git materializes the result:");
	console.log(subjects);
	console.log(`Status: ${(await git(targetPath, "status", "--short")) || "(clean)"}`);
} finally {
	if (keep) {
		console.log(`\nKept temporary repositories at ${root}`);
	} else {
		await nodeFs.rm(root, { recursive: true, force: true });
	}
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return run(["git", ...args], cwd);
}

async function run(command: string[], cwd: string): Promise<string> {
	const process = Bun.spawn(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			`${command.join(" ")} failed (${exitCode})${stderr ? `:\n${stderr.trimEnd()}` : ""}`,
		);
	}
	return stdout.trimEnd();
}

function shortHash(hash: string): string {
	return hash.slice(0, 7);
}
