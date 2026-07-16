import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableFileSystemFromNodeFs } from "../../src/fs/node-durable-fs.ts";
import { FileSystemRefStore } from "../../src/lib/refs/store.ts";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const tempDirs: string[] = [];

async function splitStores() {
	const root = await nodeFs.mkdtemp(join(tmpdir(), "just-git-linked-ref-locks-"));
	tempDirs.push(root);
	const commonDir = join(root, "repo.git");
	const linkedGitDir = join(commonDir, "worktrees", "linked");
	await nodeFs.mkdir(linkedGitDir, { recursive: true });
	const fs = durableFileSystemFromNodeFs(nodeFs);
	return {
		fs,
		commonDir,
		linkedGitDir,
		main: new FileSystemRefStore(fs, commonDir, commonDir),
		linked: new FileSystemRefStore(fs, linkedGitDir, commonDir),
	};
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => nodeFs.rm(dir, { recursive: true, force: true })),
	);
});

describe("durable FileSystemRefStore linked-worktree routing", () => {
	test("routes per-worktree and shared mutations through their canonical lock paths", async () => {
		const { fs, commonDir, linkedGitDir, linked } = await splitStores();
		const originalLink = fs.link.bind(fs);
		const lockPaths: string[] = [];
		fs.link = async (existingPath, newPath) => {
			lockPaths.push(newPath);
			await originalLink(existingPath, newPath);
		};

		await linked.writeRef("HEAD", { type: "symbolic", target: "refs/heads/main" });
		await linked.writeRef("refs/bisect/bad", { type: "direct", hash: HASH_A });
		await linked.writeRef("refs/heads/main", { type: "direct", hash: HASH_B });
		await linked.writeRef("refs/tags/v1", { type: "direct", hash: HASH_C });

		expect(lockPaths).toContain(join(linkedGitDir, "HEAD.lock"));
		expect(lockPaths).toContain(join(linkedGitDir, "refs/bisect/bad.lock"));
		expect(lockPaths).toContain(join(commonDir, "refs/heads/main.lock"));
		expect(lockPaths).toContain(join(commonDir, "refs/tags/v1.lock"));
		expect(lockPaths).not.toContain(join(commonDir, "HEAD.lock"));
		expect(lockPaths).not.toContain(join(linkedGitDir, "refs/heads/main.lock"));
	});

	test("main and linked worktrees update independent per-worktree refs", async () => {
		const { commonDir, linkedGitDir, main, linked } = await splitStores();

		await Promise.all([
			main.writeRef("HEAD", { type: "direct", hash: HASH_A }),
			linked.writeRef("HEAD", { type: "direct", hash: HASH_B }),
		]);

		expect(await main.readRef("HEAD")).toEqual({ type: "direct", hash: HASH_A });
		expect(await linked.readRef("HEAD")).toEqual({ type: "direct", hash: HASH_B });
		expect(await nodeFs.readFile(join(commonDir, "HEAD"), "utf8")).toBe(`${HASH_A}\n`);
		expect(await nodeFs.readFile(join(linkedGitDir, "HEAD"), "utf8")).toBe(`${HASH_B}\n`);
	});

	test("main and linked handles serialize CAS through the same shared branch lock", async () => {
		const { fs, commonDir, main, linked } = await splitStores();
		await main.writeRef("refs/heads/main", { type: "direct", hash: HASH_A });
		const lockPath = join(commonDir, "refs/heads/main.lock");
		const originalLink = fs.link.bind(fs);
		let releaseFirst!: () => void;
		const firstMayLink = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstReached!: () => void;
		const firstReachedLock = new Promise<void>((resolve) => {
			firstReached = resolve;
		});
		let blockFirst = true;
		fs.link = async (existingPath, newPath) => {
			if (blockFirst && newPath === lockPath) {
				blockFirst = false;
				firstReached();
				await firstMayLink;
			}
			await originalLink(existingPath, newPath);
		};

		const first = main.compareAndSwapRef(
			"refs/heads/main",
			{ type: "direct", hash: HASH_A },
			{ type: "direct", hash: HASH_B },
		);
		await firstReachedLock;
		let secondFinished = false;
		const second = linked
			.compareAndSwapRef(
				"refs/heads/main",
				{ type: "direct", hash: HASH_A },
				{ type: "direct", hash: HASH_C },
			)
			.then((result) => {
				secondFinished = true;
				return result;
			});

		await Promise.resolve();
		expect(secondFinished).toBe(false);
		releaseFirst();
		expect(await Promise.all([first, second])).toEqual([true, false]);
		expect(await linked.readRef("refs/heads/main")).toEqual({
			type: "direct",
			hash: HASH_B,
		});
		expect(await fs.exists(lockPath)).toBe(false);
	});
});
