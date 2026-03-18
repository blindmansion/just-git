import { Bash, InMemoryFs } from "just-bash";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGit } from "../../src/index.ts";
import { findGitDir } from "../../src/lib/repo.ts";
import type { GitContext } from "../../src/lib/types.ts";
import { createGitServer } from "../../src/server/handler.ts";
import type { GitServerConfig } from "../../src/server/types.ts";

// ── Test env (server-specific, same author/committer names) ─────────

export const SERVER_TEST_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
	GIT_AUTHOR_DATE: "1000000000",
	GIT_COMMITTER_DATE: "1000000000",
};

export function envAt(ts: number) {
	return { ...SERVER_TEST_ENV, GIT_AUTHOR_DATE: String(ts), GIT_COMMITTER_DATE: String(ts) };
}

// ── just-git client factory ─────────────────────────────────────────

export function createServerClient() {
	const fs = new InMemoryFs();
	const git = createGit();
	return new Bash({ fs, cwd: "/", customCommands: [git] });
}

// ── Real git runner ─────────────────────────────────────────────────

export async function createRealGitHome() {
	return mkdtemp(join(tmpdir(), "just-git-server-home-"));
}

export async function realGit(
	home: string,
	cwd: string,
	command: string,
	extraEnv?: Record<string, string>,
) {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_PROTOCOL_VERSION: "1",
		GIT_AUTHOR_NAME: "Real Git",
		GIT_AUTHOR_EMAIL: "real@test.com",
		GIT_COMMITTER_NAME: "Real Git",
		GIT_COMMITTER_EMAIL: "real@test.com",
		...extraEnv,
	};
	const proc = Bun.spawn(["sh", "-c", `git ${command}`], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

// ── VFS server repo setup ───────────────────────────────────────────

export async function setupVfsServerRepo(
	files: Record<string, string> = {
		"/repo/README.md": "# Hello World",
		"/repo/src/main.ts": 'console.log("hello");',
	},
) {
	const serverFs = new InMemoryFs();
	const git = createGit();
	const serverBash = new Bash({ fs: serverFs, cwd: "/repo", customCommands: [git] });

	for (const [path, content] of Object.entries(files)) {
		await serverBash.writeFile(path, content);
	}

	await serverBash.exec("git init");
	await serverBash.exec("git add .");
	await serverBash.exec('git commit -m "initial commit"', { env: envAt(1000000000) });

	const ctx = await findGitDir(serverFs, "/repo");
	if (!ctx) throw new Error("failed to find git dir");

	return { serverFs, serverBash, serverRepo: ctx as GitContext };
}

// ── HTTP server wrapper ─────────────────────────────────────────────

export function startServer(config: GitServerConfig) {
	const server = createGitServer(config);
	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	return { srv, port: srv.port!, stop: () => srv.stop() };
}

// ── Temp dir helper ─────────────────────────────────────────────────

export async function createSandbox(prefix = "just-git-server-") {
	return mkdtemp(join(tmpdir(), prefix));
}
