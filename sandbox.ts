#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Bash, ReadWriteFs } from "just-bash";
import { createGit } from "./src/git";

const SANDBOX_DIR = join(dirname(import.meta.path), ".sandbox");
const STATE_FILE = join(SANDBOX_DIR, ".sandbox-cwd");

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
	console.log(`Usage: bun sandbox <command>

Run shell commands against just-git backed by a real filesystem.
State persists in .sandbox/ between invocations.

Options:
  --reset    Wipe the sandbox and start fresh
  --cwd      Print the current working directory

Commands are executed via just-bash with just-git registered.
The sandbox directory is also a real directory — you can inspect
it with real git for comparison.

Examples:
  bun sandbox "git init"
  bun sandbox "echo 'hello' > README.md"
  bun sandbox "git add . && git commit -m 'first commit'"
  bun sandbox "git log --oneline"
  bun sandbox "cd subdir && git status"

  # Compare with real git
  cd .sandbox && git log --oneline

  # Start over
  bun sandbox --reset`);
	process.exit(0);
}

if (args.includes("--reset")) {
	if (existsSync(SANDBOX_DIR)) {
		rmSync(SANDBOX_DIR, { recursive: true, force: true });
		console.log("Sandbox reset.");
	} else {
		console.log("Sandbox already clean.");
	}
	process.exit(0);
}

if (args.includes("--cwd")) {
	const cwd = readCwd();
	console.log(cwd);
	process.exit(0);
}

mkdirSync(SANDBOX_DIR, { recursive: true });

const cwd = readCwd();
const rwfs = new ReadWriteFs({ root: SANDBOX_DIR });
const git = createGit({
	identity: { name: "Sandbox User", email: "sandbox@just-git.dev" },
});
const bash = new Bash({ fs: rwfs, cwd, customCommands: [git] });

const command = args.join(" ");
const result = await bash.exec(command);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

// Persist cwd if it changed (e.g. via cd)
const newCwd = bash.getCwd();
if (newCwd !== cwd) {
	saveCwd(newCwd);
}

process.exit(result.exitCode);

function readCwd(): string {
	try {
		return readFileSync(STATE_FILE, "utf-8").trim() || "/";
	} catch {
		return "/";
	}
}

function saveCwd(dir: string): void {
	writeFileSync(STATE_FILE, dir);
}
