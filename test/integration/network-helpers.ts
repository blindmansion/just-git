import { Bash } from "just-bash";
import { createGit } from "../../src/git.ts";

const TEST_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

export interface NetworkEnv {
	token: string;
	repo: string;
}

export function loadNetworkEnv(): NetworkEnv | null {
	const token = process.env.GITHUB_TEST_TOKEN;
	let repo = process.env.GITHUB_TEST_REPO;
	if (!token || !repo) return null;
	if (!repo.endsWith(".git")) repo += ".git";
	return { token, repo };
}

/** Auth via createGit({ credentials }) callback. */
export function createAuthBash(env: NetworkEnv): Bash {
	const git = createGit({
		credentials: async () => ({
			type: "basic",
			username: "x-access-token",
			password: env.token,
		}),
	});
	return new Bash({
		cwd: "/repo",
		customCommands: [git],
		env: { ...TEST_ENV },
	});
}

/** Auth via GIT_HTTP_USER + GIT_HTTP_PASSWORD env vars (no credential provider). */
export function createEnvAuthBash(env: NetworkEnv): Bash {
	const git = createGit();
	return new Bash({
		cwd: "/repo",
		customCommands: [git],
		env: {
			...TEST_ENV,
			GIT_HTTP_USER: "x-access-token",
			GIT_HTTP_PASSWORD: env.token,
		},
	});
}

/** Auth via credential provider that returns null, falling back to env vars. */
export function createFallbackAuthBash(env: NetworkEnv): Bash {
	const git = createGit({
		credentials: async () => null,
	});
	return new Bash({
		cwd: "/repo",
		customCommands: [git],
		env: {
			...TEST_ENV,
			GIT_HTTP_USER: "x-access-token",
			GIT_HTTP_PASSWORD: env.token,
		},
	});
}

let counter = 0;

export function uniqueRef(prefix: string): string {
	const ts = Date.now();
	const id = (counter++).toString(36);
	return `test/${prefix}-${ts}-${id}`;
}

export function skipLog(label: string): void {
	console.log(`SKIP (${label}): GITHUB_TEST_TOKEN / GITHUB_TEST_REPO not set`);
}
