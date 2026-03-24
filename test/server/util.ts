import { Bash, InMemoryFs } from "just-bash";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGit } from "../../src/index.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import type { Auth, GitServerConfig } from "../../src/server/types.ts";

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
	const server = createServer(config);
	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	return { server, srv, port: srv.port!, stop: () => srv.stop() };
}

export const defaultHttpAuth = (req: Request): Auth => ({
	transport: "http",
	request: req,
});

/**
 * Start a server with auth-provider-based HTTP auth.
 * The authorize callback returns true to allow, false for 403,
 * or a Response to send directly (e.g. 401).
 */
export function startServerWithAuth(
	authorize: (request: Request) => boolean | Response | Promise<boolean | Response>,
	config: GitServerConfig,
) {
	const server = createServer({
		...config,
		auth: {
			http: async (req) => {
				const result = await authorize(req);
				if (result instanceof Response) return result;
				if (!result) return new Response("Forbidden", { status: 403 });
				return defaultHttpAuth(req);
			},
		},
	});
	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	return { server, srv, port: srv.port!, stop: () => srv.stop() };
}

/**
 * Create a MemoryStorage-backed server with a pre-created (empty) repo.
 * Returns the server, HTTP port, and stop function.
 */
export async function startMemoryServer(
	repoId = "test-repo",
	configOverrides?: Partial<GitServerConfig>,
) {
	const driver = new MemoryStorage();
	const config: GitServerConfig = {
		storage: driver,
		...configOverrides,
	};
	const server = createServer(config);
	await server.createRepo(repoId);
	const srv = Bun.serve({ fetch: server.fetch, port: 0 });
	return { server, srv, port: srv.port!, stop: () => srv.stop() };
}

/**
 * Create a MemoryStorage-backed server, create a repo, and seed it
 * with initial content by pushing from a virtual client.
 */
export async function createSeededServer(
	files: Record<string, string> = { "README.md": "# Test" },
	repoId = "test-repo",
	configOverrides?: Partial<GitServerConfig>,
) {
	const { server, srv, port, stop } = await startMemoryServer(repoId, configOverrides);

	const client = createServerClient();
	const url = `http://localhost:${port}/${repoId}`;

	await client.exec(`git clone ${url} /repo`, { env: SERVER_TEST_ENV });
	for (const [path, content] of Object.entries(files)) {
		const dir = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
		if (dir) await client.exec(`mkdir -p /repo/${dir}`, { env: SERVER_TEST_ENV });
		await client.writeFile(`/repo/${path}`, content);
	}
	await client.exec("git add .", { cwd: "/repo", env: SERVER_TEST_ENV });
	await client.exec('git commit -m "initial"', { cwd: "/repo", env: SERVER_TEST_ENV });
	await client.exec("git push origin main", { cwd: "/repo", env: SERVER_TEST_ENV });

	return { server, srv, port, stop };
}

// ── Temp dir helper ─────────────────────────────────────────────────

export async function createSandbox(prefix = "just-git-server-") {
	return mkdtemp(join(tmpdir(), prefix));
}
