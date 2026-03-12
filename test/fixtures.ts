import type { InitialFiles } from "just-bash";

// ── Common test env ─────────────────────────────────────────────────

/** Standard test identity + deterministic timestamps. */
export const TEST_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
	GIT_AUTHOR_DATE: "1000000000",
	GIT_COMMITTER_DATE: "1000000000",
};

/** Like TEST_ENV but with distinct author/committer names. */
export const TEST_ENV_NAMED = {
	GIT_AUTHOR_NAME: "Test Author",
	GIT_AUTHOR_EMAIL: "author@test.com",
	GIT_COMMITTER_NAME: "Test Committer",
	GIT_COMMITTER_EMAIL: "committer@test.com",
	GIT_AUTHOR_DATE: "1000000000",
	GIT_COMMITTER_DATE: "1000000000",
};

/** Build an env with overridden timestamps. Uses TEST_ENV_NAMED. */
export function envAt(ts: string) {
	return { ...TEST_ENV_NAMED, GIT_AUTHOR_DATE: ts, GIT_COMMITTER_DATE: ts };
}

// ── Common initial filesystem layouts ────────────────────────────────

/** Empty repo dir — just a README. */
export const EMPTY_REPO: InitialFiles = {
	"/repo/README.md": "# My Project",
};

/** Repo with a basic src/ layout. */
export const BASIC_REPO: InitialFiles = {
	"/repo/README.md": "# My Project",
	"/repo/src/main.ts": 'console.log("hello world");',
	"/repo/src/util.ts": "export const VERSION = 1;",
};

/** Repo with nested directories and multiple file types. */
export const NESTED_REPO: InitialFiles = {
	"/repo/README.md": "# My Project",
	"/repo/src/index.ts": "export {};",
	"/repo/src/lib/math.ts": "export const add = (a: number, b: number) => a + b;",
	"/repo/src/lib/string.ts": "export const trim = (s: string) => s.trim();",
	"/repo/docs/guide.md": "# Guide",
};
