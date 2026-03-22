import { Bash, InMemoryFs } from "just-bash";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGit } from "../../src/index.ts";
import { createGitServer } from "../../src/server/handler.ts";
import type { GitServerConfig, Session } from "../../src/server/types.ts";

// ── Test env ────────────────────────────────────────────────────────

const SERVER_TEST_ENV = {
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

// ── HTTP server wrapper ─────────────────────────────────────────────

export function startServer(config: GitServerConfig) {
	const server = createGitServer(config);
	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	return { srv, port: srv.port!, stop: () => srv.stop() };
}

export const defaultSshSession = (info: { username?: string }) =>
	({ transport: "ssh" as const, username: info.username }) satisfies Session;

export const defaultHttpSession = (req: Request) =>
	({ transport: "http" as const, request: req }) satisfies Session;

/**
 * Start a server with session-builder-based HTTP auth.
 * The authorize callback returns true to allow, false for 403,
 * or a Response to send directly (e.g. 401).
 */
export function startServerWithSessionAuth(
	authorize: (request: Request) => boolean | Response | Promise<boolean | Response>,
	config: GitServerConfig,
) {
	const server = createGitServer({
		...config,
		session: {
			http: async (req) => {
				const result = await authorize(req);
				if (result instanceof Response) return result;
				if (!result) return new Response("Forbidden", { status: 403 });
				return defaultHttpSession(req);
			},
			ssh: defaultSshSession,
		},
	});
	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	return { srv, port: srv.port!, stop: () => srv.stop() };
}

// ── Temp dir helper ─────────────────────────────────────────────────

export async function createSandbox(prefix = "just-git-server-") {
	return mkdtemp(join(tmpdir(), prefix));
}
