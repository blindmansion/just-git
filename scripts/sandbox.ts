#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { Bash, ReadWriteFs } from "just-bash";
import { createGit } from "../src/git";
import { createServer, BunSqliteStorage } from "../src/server";
import { getChangedFiles } from "../src/repo";

const PROJECT_ROOT = join(dirname(import.meta.path), "..");
const SANDBOX_DIR = join(PROJECT_ROOT, ".sandbox");
const STATE_FILE = join(SANDBOX_DIR, ".sandbox-cwd");
const SERVER_DIR = join(PROJECT_ROOT, ".sandbox-server");
const SERVER_DB = join(SERVER_DIR, "server.sqlite");
const SERVER_PID = join(SERVER_DIR, "server.pid");
const DEFAULT_PORT = 4200;

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
	console.log(`Usage: bun sandbox <command>
       bun sandbox server [options]

Run shell commands against just-git backed by a real filesystem.
State persists in .sandbox/ between invocations.

Options:
  --reset    Wipe the sandbox and start fresh
  --cwd      Print the current working directory

Subcommands:
  server     Start a just-git HTTP server backed by SQLite

Server options:
  --port <n>    Port to listen on (default: ${DEFAULT_PORT}, or PORT env var)
  --stop        Stop a running server
  --reset       Clear all server data and start fresh
  --memory      Use in-memory database (no persistence)

Commands are executed via just-bash with just-git registered.
The sandbox directory is also a real directory — you can inspect
it with real git for comparison.

Examples:
  bun sandbox "git init"
  bun sandbox "echo 'hello' > README.md"
  bun sandbox "git add . && git commit -m 'first commit'"
  bun sandbox "git log --oneline"
  bun sandbox "cd subdir && git status"

  # Start a git server
  bun sandbox server
  bun sandbox server --port 8080

  # Push to the server (from another terminal)
  bun sandbox "git remote add origin http://localhost:4200/my-repo"
  bun sandbox "git push -u origin main"

  # Or clone from real git
  git clone http://localhost:4200/my-repo

  # Stop / reset the server
  bun sandbox server --stop
  bun sandbox server --reset

  # Compare with real git
  cd .sandbox && git log --oneline

  # Start over (clears sandbox and server data)
  bun sandbox --reset`);
	process.exit(0);
}

// ── server subcommand ───────────────────────────────────────────────

if (args[0] === "server") {
	const serverArgs = args.slice(1);

	if (serverArgs.includes("--stop")) {
		stopServer();
		process.exit(0);
	}

	if (serverArgs.includes("--reset")) {
		stopServer(true);
		if (existsSync(SERVER_DIR)) {
			rmSync(SERVER_DIR, { recursive: true, force: true });
			console.log("Server database cleared.");
		} else {
			console.log("Server database already clean.");
		}
		if (serverArgs.length === 1) process.exit(0);
	}

	mkdirSync(SERVER_DIR, { recursive: true });

	const useMemory = serverArgs.includes("--memory");
	const portIdx = serverArgs.indexOf("--port");
	const port =
		portIdx !== -1 ? Number(serverArgs[portIdx + 1]) : Number(process.env.PORT ?? DEFAULT_PORT);

	const dbPath = useMemory ? ":memory:" : SERVER_DB;
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");

	const server = createServer({
		storage: new BunSqliteStorage(db),
		autoCreate: true,
		hooks: {
			postReceive: async ({ repo, updates }) => {
				for (const u of updates) {
					const files = await getChangedFiles(repo, u.oldHash, u.newHash);
					console.log(
						`  [push] ${u.ref}: ${(u.oldHash ?? "0000000").slice(0, 7)}..${u.newHash.slice(0, 7)} (${files.length} files changed)`,
					);
				}
			},
		},
	});

	stopServer(true);

	const srv = Bun.serve({ fetch: server.fetch, port });

	writeFileSync(SERVER_PID, `${process.pid}\n${srv.port}`);
	const cleanup = () => {
		try {
			rmSync(SERVER_PID, { force: true });
		} catch {}
	};
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});
	process.on("exit", cleanup);

	console.log(`just-git server listening on http://localhost:${srv.port}`);
	console.log(`database: ${useMemory ? "(in-memory)" : SERVER_DB}`);
	console.log();
	console.log("usage:");
	console.log(`  git clone http://localhost:${srv.port}/<repo-name>`);
	console.log(`  bun sandbox "git remote add origin http://localhost:${srv.port}/<repo-name>"`);
	console.log(`  bun sandbox "git push -u origin main"`);
	console.log();
	console.log("stop with: bun sandbox server --stop");
} else {
	// ── shell command mode ──────────────────────────────────────────

	if (args.includes("--reset")) {
		let cleaned = false;
		if (existsSync(SANDBOX_DIR)) {
			rmSync(SANDBOX_DIR, { recursive: true, force: true });
			cleaned = true;
		}
		if (existsSync(SERVER_DIR)) {
			rmSync(SERVER_DIR, { recursive: true, force: true });
			cleaned = true;
		}
		console.log(cleaned ? "Sandbox reset." : "Sandbox already clean.");
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

	const newCwd = bash.getCwd();
	if (newCwd !== cwd) {
		saveCwd(newCwd);
	}

	process.exit(result.exitCode);
}

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

function stopServer(quiet = false): void {
	if (!existsSync(SERVER_PID)) {
		if (!quiet) console.log("No server running.");
		return;
	}
	try {
		const content = readFileSync(SERVER_PID, "utf-8").trim();
		const [pidStr, portStr] = content.split("\n");
		const pid = Number(pidStr);
		process.kill(pid, "SIGTERM");
		rmSync(SERVER_PID, { force: true });
		if (!quiet) console.log(`Server stopped (pid ${pid}, port ${portStr}).`);
	} catch (e: any) {
		rmSync(SERVER_PID, { force: true });
		if (e?.code === "ESRCH") {
			if (!quiet) console.log("Server was not running (stale pid file removed).");
		} else {
			throw e;
		}
	}
}
