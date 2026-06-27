import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { everyPath } from "../../src/lib/attribute-resolver.ts";
import { withCapabilities } from "../../src/lib/capabilities.ts";
import { findRepo } from "../../src/lib/repo.ts";
import type { CapabilityContext, GitRepo } from "../../src/lib/types.ts";
import { readBlobText } from "../../src/repo/reading.ts";
import { flattenTree } from "../../src/repo/diffing.ts";
import { mergeTrees, mergeTreesFromTreeHashes } from "../../src/repo/merging.ts";
import { readCommit } from "../../src/lib/object-db.ts";
import { type TextMergeInput, TEST_ENV, textMergeDriver } from "../fixtures.ts";

function envAt(ts: number) {
	return { ...TEST_ENV, GIT_AUTHOR_DATE: String(ts), GIT_COMMITTER_DATE: String(ts) };
}

async function readFileFromTree(repo: GitRepo, treeHash: string, path: string): Promise<string> {
	const entries = await flattenTree(repo, treeHash);
	const entry = entries.find((e) => e.path === path);
	if (!entry) throw new Error(`file ${path} not found in tree ${treeHash}`);
	return readBlobText(repo, entry.hash);
}

async function getRefHash(repo: GitRepo, refName: string): Promise<string> {
	const ref = await repo.refStore.readRef(refName);
	if (!ref) throw new Error(`ref ${refName} not found`);
	if (ref.type === "symbolic") return getRefHash(repo, ref.target);
	return ref.hash;
}

async function setupDivergent(opts?: {
	baseContent?: string;
	oursContent?: string;
	theirsContent?: string;
	path?: string;
}): Promise<{ repo: GitRepo; oursHash: string; theirsHash: string; fs: InMemoryFs }> {
	const filePath = opts?.path ?? "file.txt";
	const fs = new InMemoryFs();
	const git = createGit();
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

	await bash.writeFile(`/repo/${filePath}`, opts?.baseContent ?? "line1\nline2\nline3\n");
	await bash.exec("git init", { env: TEST_ENV });
	await bash.exec("git add .", { env: TEST_ENV });
	await bash.exec('git commit -m "initial"', { env: envAt(1000000000) });

	await bash.exec("git checkout -b feature", { env: TEST_ENV });
	await bash.writeFile(`/repo/${filePath}`, opts?.theirsContent ?? "line1\nline2-theirs\nline3\n");
	await bash.exec("git add .", { env: TEST_ENV });
	await bash.exec('git commit -m "theirs"', { env: envAt(1000000002) });

	await bash.exec("git checkout main", { env: TEST_ENV });
	await bash.writeFile(`/repo/${filePath}`, opts?.oursContent ?? "line1\nline2-ours\nline3\n");
	await bash.exec("git add .", { env: TEST_ENV });
	await bash.exec('git commit -m "ours"', { env: envAt(1000000004) });

	const repo = (await findRepo(fs, "/repo"))!;
	const oursHash = await getRefHash(repo, "refs/heads/main");
	const theirsHash = await getRefHash(repo, "refs/heads/feature");

	return { repo, oursHash, theirsHash, fs };
}

describe("mergeDriver", () => {
	test("driver resolves a conflict cleanly", async () => {
		const { repo, oursHash, theirsHash } = await setupDivergent();

		const driver = textMergeDriver((_ctx, { ours, theirs }) => {
			return { content: `${ours.trim()}\n${theirs.trim()}\n`, conflict: false };
		});

		const result = await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(result.clean).toBe(true);
		expect(result.conflicts).toHaveLength(0);

		const blob = await readFileFromTree(repo, result.treeHash, "file.txt");
		expect(blob).toBe("line1\nline2-ours\nline3\nline1\nline2-theirs\nline3\n");
	});

	test("driver returns conflict: true preserves index stages", async () => {
		const { repo, oursHash, theirsHash } = await setupDivergent();

		const driver = textMergeDriver((_ctx, { ours, theirs }) => {
			return { content: `CUSTOM-CONFLICT\n${ours}${theirs}`, conflict: true };
		});

		const result = await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(result.clean).toBe(false);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]!.path).toBe("file.txt");
	});

	test("driver returning null falls back to diff3", async () => {
		const { repo, oursHash, theirsHash } = await setupDivergent();

		let called = false;
		const driver = textMergeDriver(() => {
			called = true;
			return null;
		});

		const result = await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(called).toBe(true);
		expect(result.clean).toBe(false);
		expect(result.conflicts).toHaveLength(1);
	});

	test("driver not called for non-conflicting one-sided changes", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/a.txt", "base\n");
		await bash.writeFile("/repo/b.txt", "base\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "initial"', { env: envAt(1000000000) });

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/a.txt", "theirs\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "theirs"', { env: envAt(1000000002) });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.writeFile("/repo/b.txt", "ours\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "ours"', { env: envAt(1000000004) });

		const repo = (await findRepo(fs, "/repo"))!;
		const oursHash = await getRefHash(repo, "refs/heads/main");
		const theirsHash = await getRefHash(repo, "refs/heads/feature");

		const calledPaths: string[] = [];
		const driver = textMergeDriver((_ctx, { path }) => {
			calledPaths.push(path);
			return null;
		});

		const result = await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(result.clean).toBe(true);
		expect(calledPaths).toHaveLength(0);
	});

	test("selective driver: only handle certain file extensions", async () => {
		const { repo, oursHash, theirsHash } = await setupDivergent({ path: "code.ts" });

		const driver = textMergeDriver((_ctx, { path, ours, theirs }) => {
			if (!path.endsWith(".ts")) return null;
			return { content: `// merged\n${ours}${theirs}`, conflict: false };
		});

		const result = await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(result.clean).toBe(true);
		const blob = await readFileFromTree(repo, result.treeHash, "code.ts");
		expect(blob).toContain("// merged");
	});

	test("async driver", async () => {
		const { repo, oursHash, theirsHash } = await setupDivergent();

		const driver = textMergeDriver(async () => {
			await new Promise((r) => setTimeout(r, 1));
			return { content: "async-merged\n", conflict: false };
		});

		const result = await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(result.clean).toBe(true);
		const blob = await readFileFromTree(repo, result.treeHash, "file.txt");
		expect(blob).toBe("async-merged\n");
	});

	test("add/add conflict with driver resolving cleanly", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/readme.md", "hi\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "initial"', { env: envAt(1000000000) });

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/new.txt", "theirs-content\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "theirs"', { env: envAt(1000000002) });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.writeFile("/repo/new.txt", "ours-content\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "ours"', { env: envAt(1000000004) });

		const repo = (await findRepo(fs, "/repo"))!;
		const oursHash = await getRefHash(repo, "refs/heads/main");
		const theirsHash = await getRefHash(repo, "refs/heads/feature");

		const driver = textMergeDriver((_ctx, { base, ours, theirs }) => {
			expect(base).toBeNull();
			return { content: `${ours.trim()}+${theirs.trim()}\n`, conflict: false };
		});

		const result = await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(result.clean).toBe(true);
		const blob = await readFileFromTree(repo, result.treeHash, "new.txt");
		expect(blob).toBe("ours-content+theirs-content\n");
	});

	test("works with mergeTreesFromTreeHashes", async () => {
		const { repo, oursHash, theirsHash } = await setupDivergent();

		const oursCommit = await readCommit(repo, oursHash);
		const theirsCommit = await readCommit(repo, theirsHash);
		const baseCommit = await readCommit(repo, oursCommit.parents[0]!);

		const driver = textMergeDriver(() => {
			return { content: "from-tree-hashes\n", conflict: false };
		});

		const result = await mergeTreesFromTreeHashes(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			baseCommit.tree,
			oursCommit.tree,
			theirsCommit.tree,
		);

		expect(result.clean).toBe(true);
		const blob = await readFileFromTree(repo, result.treeHash, "file.txt");
		expect(blob).toBe("from-tree-hashes\n");
	});

	test("driver receives correct path, base, ours, theirs content", async () => {
		const baseContent = "base-content\n";
		const oursContent = "ours-content\n";
		const theirsContent = "theirs-content\n";

		const { repo, oursHash, theirsHash } = await setupDivergent({
			baseContent,
			oursContent,
			theirsContent,
		});

		let capturedInput: TextMergeInput | null = null;
		const driver = textMergeDriver((_ctx, input) => {
			capturedInput = input;
			return null;
		});

		await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(capturedInput).not.toBeNull();
		expect(capturedInput!.path).toBe("file.txt");
		expect(capturedInput!.base).toBe(baseContent);
		expect(capturedInput!.ours).toBe(oursContent);
		expect(capturedInput!.theirs).toBe(theirsContent);
	});

	test("driver receives a CapabilityContext with operation and a config view", async () => {
		const { repo, oursHash, theirsHash } = await setupDivergent();

		let capturedCtx: CapabilityContext | null = null;
		const driver = textMergeDriver((ctx) => {
			capturedCtx = ctx;
			return null;
		});

		await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(capturedCtx).not.toBeNull();
		expect(capturedCtx!.operation).toBe("merge");
		expect(capturedCtx!.repo.objectStore).toBe(repo.objectStore);
		// `core.bare` is written by `git init`; the snapshot view reads it back.
		expect(capturedCtx!.config.get("core.bare")).toBe("false");
		expect(capturedCtx!.config.get("nonexistent.key")).toBeUndefined();
	});

	test("config view reflects capabilities.config overrides", async () => {
		const { repo, oursHash, theirsHash } = await setupDivergent();

		let lockedValue: string | undefined;
		const driver = textMergeDriver((ctx) => {
			lockedValue = ctx.config.get("merge.mydriver");
			return null;
		});

		await mergeTrees(
			withCapabilities(repo, {
				attributes: everyPath({ merge: driver }),
				config: { locked: { "merge.mydriver": "on" } },
			}),
			oursHash,
			theirsHash,
		);

		expect(lockedValue).toBe("on");
	});

	test("without mergeDriver, existing behavior is unchanged", async () => {
		const { repo, oursHash, theirsHash } = await setupDivergent();

		const result = await mergeTrees(repo, oursHash, theirsHash);

		expect(result.clean).toBe(false);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]!.path).toBe("file.txt");
	});

	test("driver invoked for rename+content conflicts", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

		await bash.writeFile("/repo/old.txt", "line1\nline2\nline3\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "initial"', { env: envAt(1000000000) });

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/old.txt", "line1\nline2-theirs\nline3\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "theirs modifies"', { env: envAt(1000000002) });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.exec("git mv old.txt new.txt", { env: TEST_ENV });
		await bash.writeFile("/repo/new.txt", "line1\nline2-ours\nline3\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "ours renames+modifies"', { env: envAt(1000000004) });

		const repo = (await findRepo(fs, "/repo"))!;
		const oursHash = await getRefHash(repo, "refs/heads/main");
		const theirsHash = await getRefHash(repo, "refs/heads/feature");

		const calledPaths: string[] = [];
		const driver = textMergeDriver((_ctx, { path }) => {
			calledPaths.push(path);
			return { content: "rename-merged\n", conflict: false };
		});

		const result = await mergeTrees(
			withCapabilities(repo, { attributes: everyPath({ merge: driver }) }),
			oursHash,
			theirsHash,
		);

		expect(result.clean).toBe(true);
		expect(calledPaths.length).toBeGreaterThan(0);
	});
});
