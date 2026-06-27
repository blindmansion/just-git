import type { InitialFiles } from "just-bash";
import type { MergeDriver } from "../src/lib/merge-ort.ts";
import type { CapabilityContext } from "../src/lib/types.ts";

// ── Merge driver test ergonomics ────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Text view of a `MergeDriverInput` for string-based test drivers. */
export interface TextMergeInput {
	path: string;
	base: string | null;
	ours: string;
	theirs: string;
}

/** Result of a string-based test merge driver. */
export interface TextMergeResult {
	content: string;
	conflict: boolean;
}

/**
 * Wrap a string-based merge driver into the bytes-contract {@link MergeDriver}.
 * Decodes each side to text on the way in and encodes the result on the way out,
 * so tests keep expressing merges in plain strings.
 */
export function textMergeDriver(
	fn: (
		ctx: CapabilityContext,
		input: TextMergeInput,
	) => TextMergeResult | null | Promise<TextMergeResult | null>,
): MergeDriver {
	return async (ctx, input) => {
		const result = await fn(ctx, {
			path: input.path,
			base: input.base === null ? null : dec.decode(input.base),
			ours: dec.decode(input.ours),
			theirs: dec.decode(input.theirs),
		});
		if (result === null) return null;
		return { content: enc.encode(result.content), conflict: result.conflict };
	};
}

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
