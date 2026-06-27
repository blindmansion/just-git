import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { bindAttributes } from "../../src/lib/bound-attributes.ts";
import { withCapabilities } from "../../src/lib/capabilities.ts";
import type { FilterConfig } from "../../src/lib/filters.ts";
import type { MergeDriver } from "../../src/lib/merge-ort.ts";
import { findRepo } from "../../src/lib/repo.ts";
import type { GitContext } from "../../src/lib/types.ts";
import { TEST_ENV } from "../fixtures.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Init an in-memory repo, optionally with `.gitattributes`, return its context. */
async function initRepo(opts?: {
	gitattributes?: string;
	capabilities?: Parameters<typeof withCapabilities>[1];
}): Promise<GitContext> {
	const fs = new InMemoryFs();
	const git = createGit();
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
	if (opts?.gitattributes !== undefined) {
		await bash.writeFile("/repo/.gitattributes", opts.gitattributes);
	}
	await bash.exec("git init", { env: TEST_ENV });
	// lib `findRepo` does not attach capabilities; wire them explicitly.
	const repo = (await findRepo(fs, "/repo"))! as GitContext;
	return opts?.capabilities ? (withCapabilities(repo, opts.capabilities) as GitContext) : repo;
}

describe("bindAttributes (Phase 1 — unified bound handle over today's caps)", () => {
	test("returns undefined when neither filters nor mergeDriver are configured", async () => {
		const repo = await initRepo();
		expect(await bindAttributes(repo, "add")).toBeUndefined();
	});

	test("clean/smudge delegate to filters resolved via .gitattributes + registry", async () => {
		const filters: FilterConfig = {
			up: {
				clean: (_ctx, input) => enc.encode(dec.decode(input.content).toUpperCase()),
				smudge: (_ctx, input) => enc.encode(dec.decode(input.content).toLowerCase()),
			},
		};
		const repo = await initRepo({ gitattributes: "*.md filter=up\n", capabilities: { filters } });

		const bound = (await bindAttributes(repo, "add"))!;
		expect(bound).toBeDefined();

		// Attributed path is filtered…
		expect(dec.decode(await bound.clean("readme.md", enc.encode("hello")))).toBe("HELLO");
		expect(dec.decode(await bound.smudge("readme.md", enc.encode("HELLO")))).toBe("hello");
		// …an unattributed path is passthrough.
		expect(dec.decode(await bound.clean("code.ts", enc.encode("hello")))).toBe("hello");
	});

	test("merge is the global mergeDriver when configured, undefined otherwise", async () => {
		const driver: MergeDriver = (_ctx, input) => ({
			content: `merged:${input.path}`,
			conflict: false,
		});
		const withDriver = await initRepo({ capabilities: { mergeDriver: driver } });

		const bound = (await bindAttributes(withDriver, "merge"))!;
		expect(bound).toBeDefined();
		expect(bound.merge).toBeDefined();
		// Phase 1: the global driver fires for every path (no per-path selection yet).
		const result = await bound.merge!({ path: "any/file.txt", base: null, ours: "a", theirs: "b" });
		expect(result).toEqual({ content: "merged:any/file.txt", conflict: false });

		// Filters present but no mergeDriver → bound exists, merge is undefined.
		const filters: FilterConfig = { up: { clean: (_c, i) => i.content } };
		const onlyFilters = await initRepo({
			gitattributes: "*.md filter=up\n",
			capabilities: { filters },
		});
		const boundNoMerge = (await bindAttributes(onlyFilters, "merge"))!;
		expect(boundNoMerge).toBeDefined();
		expect(boundNoMerge.merge).toBeUndefined();
	});

	test("a bare GitRepo (no fs) yields merge only; clean/smudge passthrough", async () => {
		const driver: MergeDriver = (_ctx, input) => ({ content: input.ours, conflict: false });
		const repo = await initRepo({ capabilities: { mergeDriver: driver } });
		// Strip the GitContext-only members to simulate a bare GitRepo handle.
		const bare = {
			objectStore: repo.objectStore,
			refStore: repo.refStore,
			capabilities: repo.capabilities,
		};

		const bound = (await bindAttributes(bare, "merge"))!;
		expect(bound.merge).toBeDefined();
		// No vfs → filters can't bind → clean/smudge are passthrough.
		expect(dec.decode(await bound.clean("x.md", enc.encode("raw")))).toBe("raw");
		expect(dec.decode(await bound.smudge("x.md", enc.encode("raw")))).toBe("raw");
	});
});
