import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableFileSystemFromNodeFs } from "../../src/fs/node-durable-fs.ts";
import {
	createNativeRefMutation,
	NativeRefLockContentionError,
} from "../../src/lib/refs/native-mutation.ts";
import { writePackedRefsNative } from "../../src/lib/refs/packed-refs-transaction.ts";
import { FileSystemRefStore } from "../../src/lib/refs/store.ts";
import { isolatedGitEnv } from "../real-git.ts";

const tempDirs: string[] = [];
const GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "Ref Lock Interop",
	GIT_AUTHOR_EMAIL: "ref-locks@test.com",
	GIT_COMMITTER_NAME: "Ref Lock Interop",
	GIT_COMMITTER_EMAIL: "ref-locks@test.com",
};

interface RepoFixture {
	root: string;
	gitDir: string;
	env: Record<string, string>;
	oldHash: string;
	newHash: string;
}

interface PreparedUpdate {
	commit(): Promise<GitResult>;
	abort(): Promise<void>;
}

interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function repoFixture(): Promise<RepoFixture> {
	const root = await nodeFs.mkdtemp(join(tmpdir(), "just-git-ref-lock-interop-"));
	tempDirs.push(root);
	const env = isolatedGitEnv(root, GIT_IDENTITY);
	expect((await git(root, env, ["init"])).exitCode).toBe(0);
	expect((await git(root, env, ["commit", "--allow-empty", "-m", "old"])).exitCode).toBe(0);
	const oldHash = (await git(root, env, ["rev-parse", "HEAD"])).stdout.trim();
	expect((await git(root, env, ["commit", "--allow-empty", "-m", "new"])).exitCode).toBe(0);
	const newHash = (await git(root, env, ["rev-parse", "HEAD"])).stdout.trim();
	return { root, gitDir: join(root, ".git"), env, oldHash, newHash };
}

async function git(cwd: string, env: Record<string, string>, args: string[]): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], {
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

async function prepareUpdate(
	fixture: RepoFixture,
	command: string,
	requiredLocks: string[],
): Promise<PreparedUpdate> {
	const proc = Bun.spawn(["git", "update-ref", "--stdin"], {
		cwd: fixture.root,
		env: fixture.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(`start\n${command}\nprepare\n`);
	await proc.stdin.flush();
	await Promise.all(requiredLocks.map((path) => waitForPath(path)));
	let finished = false;

	const finish = async (action: "commit" | "abort"): Promise<GitResult> => {
		if (finished) throw new Error(`prepared update already finished`);
		finished = true;
		proc.stdin.write(`${action}\n`);
		proc.stdin.end();
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	};

	return {
		commit: () => finish("commit"),
		async abort() {
			if (finished) return;
			const result = await finish("abort");
			if (result.exitCode !== 0) {
				throw new Error(`git update-ref abort failed: ${result.stderr}`);
			}
		},
	};
}

async function waitForPath(path: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		try {
			await nodeFs.access(path);
			return;
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${JSON.stringify(path)}`);
		await Bun.sleep(5);
	}
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await nodeFs.access(path);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

async function claimantNames(parent: string, lockName: string): Promise<string[]> {
	return (await nodeFs.readdir(parent)).filter((name) => name.startsWith(`${lockName}.tmp-`));
}

function removePackedRecord(content: string, refName: string): string {
	const lines = content.split("\n");
	const kept: string[] = [];
	let removePeeled = false;
	for (const line of lines) {
		if (removePeeled && line.startsWith("^")) {
			removePeeled = false;
			continue;
		}
		removePeeled = false;
		const space = line.indexOf(" ");
		if (space !== -1 && line.slice(space + 1) === refName) {
			removePeeled = true;
			continue;
		}
		kept.push(line);
	}
	return kept.join("\n");
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((path) => nodeFs.rm(path, { recursive: true, force: true })),
	);
});

describe("interop: native ref lockfiles", () => {
	test("publishes exact loose-ref bytes through a hardlinked canonical lock", async () => {
		const fixture = await repoFixture();
		const refName = "refs/heads/hardlink-winner";
		const refPath = join(fixture.gitDir, refName);
		const lockPath = `${refPath}.lock`;
		expect(
			(await git(fixture.root, fixture.env, ["update-ref", refName, fixture.oldHash])).exitCode,
		).toBe(0);

		const fs = durableFileSystemFromNodeFs(nodeFs);
		const originalLink = fs.link.bind(fs);
		let claimantPath = "";
		let release!: () => void;
		const mayPublish = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const lockHeld = new Promise<void>((resolve) => {
			reached = resolve;
		});
		fs.link = async (existingPath, newPath) => {
			await originalLink(existingPath, newPath);
			if (newPath === lockPath) {
				claimantPath = existingPath;
				reached();
				await mayPublish;
			}
		};
		const store = new FileSystemRefStore(fs, fixture.gitDir);

		const publication = store.compareAndSwapRef(
			refName,
			{ type: "direct", hash: fixture.oldHash },
			{ type: "direct", hash: fixture.newHash },
		);
		await lockHeld;
		try {
			const [claimant, lock] = await Promise.all([
				nodeFs.stat(claimantPath),
				nodeFs.stat(lockPath),
			]);
			expect(claimant.ino).toBe(lock.ino);
			expect(claimant.nlink).toBe(2);
			expect(lock.nlink).toBe(2);
			expect(await nodeFs.readFile(lockPath, "utf8")).toBe("");
			expect(await nodeFs.readFile(refPath, "utf8")).toBe(`${fixture.oldHash}\n`);

			const blocked = await git(fixture.root, fixture.env, [
				"update-ref",
				refName,
				fixture.newHash,
				fixture.oldHash,
			]);
			expect(blocked.exitCode).not.toBe(0);
			expect(blocked.stderr).toContain("cannot lock ref");
			expect(await nodeFs.readFile(refPath, "utf8")).toBe(`${fixture.oldHash}\n`);
		} finally {
			release();
		}

		expect(await publication).toBe(true);
		expect(await nodeFs.readFile(refPath, "utf8")).toBe(`${fixture.newHash}\n`);
		expect(await pathExists(lockPath)).toBe(false);
		expect(await pathExists(claimantPath)).toBe(false);
		const resolved = await git(fixture.root, fixture.env, ["rev-parse", refName]);
		expect(resolved.exitCode).toBe(0);
		expect(resolved.stdout.trim()).toBe(fixture.newHash);
	});

	test("respects a canonical lock held by a prepared real-Git update", async () => {
		const fixture = await repoFixture();
		const refName = "refs/heads/git-winner";
		const refPath = join(fixture.gitDir, refName);
		const lockPath = `${refPath}.lock`;
		expect(
			(await git(fixture.root, fixture.env, ["update-ref", refName, fixture.oldHash])).exitCode,
		).toBe(0);
		const prepared = await prepareUpdate(
			fixture,
			`update ${refName} ${fixture.newHash} ${fixture.oldHash}`,
			[lockPath],
		);

		try {
			expect(await nodeFs.readFile(lockPath, "utf8")).toBe(`${fixture.newHash}\n`);
			const fs = durableFileSystemFromNodeFs(nodeFs);
			const mutation = createNativeRefMutation(
				fs,
				{ gitDir: fixture.gitDir, commonDir: fixture.gitDir },
				{ lockTimeoutMs: 0 },
			);
			await expect(
				mutation.compareAndSwapRef(
					refName,
					{ type: "direct", hash: fixture.oldHash },
					{ type: "direct", hash: fixture.newHash },
				),
			).rejects.toBeInstanceOf(NativeRefLockContentionError);
			expect(await nodeFs.readFile(refPath, "utf8")).toBe(`${fixture.oldHash}\n`);
			expect(await claimantNames(join(fixture.gitDir, "refs/heads"), "git-winner.lock")).toEqual(
				[],
			);

			const result = await prepared.commit();
			expect(result.exitCode).toBe(0);
		} finally {
			await prepared.abort();
		}

		expect(await nodeFs.readFile(refPath, "utf8")).toBe(`${fixture.newHash}\n`);
		expect(await pathExists(lockPath)).toBe(false);
	});

	test("writes symbolic refs in the loose format understood by real Git", async () => {
		const fixture = await repoFixture();
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const store = new FileSystemRefStore(fs, fixture.gitDir);
		const refName = "refs/heads/symbolic-alias";
		const refPath = join(fixture.gitDir, refName);

		await store.writeRef(refName, { type: "symbolic", target: "refs/heads/main" });

		expect(await nodeFs.readFile(refPath, "utf8")).toBe("ref: refs/heads/main\n");
		const symbolic = await git(fixture.root, fixture.env, ["symbolic-ref", refName]);
		expect(symbolic.exitCode).toBe(0);
		expect(symbolic.stdout.trim()).toBe("refs/heads/main");
		expect(await pathExists(`${refPath}.lock`)).toBe(false);
	});
});

describe("interop: packed ref deletion locks", () => {
	test("removes exactly one packed record and its peeled continuation", async () => {
		const fixture = await repoFixture();
		const refName = "refs/tags/delete-me";
		expect(
			(
				await git(fixture.root, fixture.env, [
					"tag",
					"-a",
					"delete-me",
					"-m",
					"packed deletion",
					fixture.oldHash,
				])
			).exitCode,
		).toBe(0);
		expect(
			(await git(fixture.root, fixture.env, ["branch", "keep-me", fixture.newHash])).exitCode,
		).toBe(0);
		expect((await git(fixture.root, fixture.env, ["pack-refs", "--all", "--prune"])).exitCode).toBe(
			0,
		);
		const packedPath = join(fixture.gitDir, "packed-refs");
		const before = await nodeFs.readFile(packedPath, "utf8");
		const tagObject = (await git(fixture.root, fixture.env, ["rev-parse", refName])).stdout.trim();
		expect(before).toContain(` ${refName}\n`);
		expect(before).toContain(`^${fixture.oldHash}\n`);

		const fs = durableFileSystemFromNodeFs(nodeFs);
		const store = new FileSystemRefStore(fs, fixture.gitDir);
		expect(await store.compareAndSwapRef(refName, { type: "direct", hash: tagObject }, null)).toBe(
			true,
		);

		expect(await nodeFs.readFile(packedPath, "utf8")).toBe(removePackedRecord(before, refName));
		expect(await pathExists(join(fixture.gitDir, refName))).toBe(false);
		expect(await pathExists(join(fixture.gitDir, `${refName}.lock`))).toBe(false);
		expect(await pathExists(`${packedPath}.lock`)).toBe(false);
		expect(await claimantNames(fixture.gitDir, "packed-refs.lock")).toEqual([]);
		expect(
			(await git(fixture.root, fixture.env, ["show-ref", "--verify", "--quiet", refName])).exitCode,
		).toBe(1);
		const retained = await git(fixture.root, fixture.env, [
			"show-ref",
			"--verify",
			"refs/heads/keep-me",
		]);
		expect(retained.exitCode).toBe(0);
		expect(retained.stdout).toContain(fixture.newHash);
	});

	test("blocks real Git while just-git holds the hardlinked packed-refs lock", async () => {
		const fixture = await repoFixture();
		const refName = "refs/heads/delete-packed";
		expect(
			(await git(fixture.root, fixture.env, ["branch", "delete-packed", fixture.oldHash])).exitCode,
		).toBe(0);
		expect((await git(fixture.root, fixture.env, ["pack-refs", "--all", "--prune"])).exitCode).toBe(
			0,
		);
		expect(
			(await git(fixture.root, fixture.env, ["branch", "new-loose", fixture.newHash])).exitCode,
		).toBe(0);

		const packedPath = join(fixture.gitDir, "packed-refs");
		const packedLockPath = `${packedPath}.lock`;
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const originalLink = fs.link.bind(fs);
		let claimantPath = "";
		let release!: () => void;
		const mayDelete = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const packedLockHeld = new Promise<void>((resolve) => {
			reached = resolve;
		});
		fs.link = async (existingPath, newPath) => {
			await originalLink(existingPath, newPath);
			if (newPath === packedLockPath) {
				claimantPath = existingPath;
				reached();
				await mayDelete;
			}
		};
		const store = new FileSystemRefStore(fs, fixture.gitDir);
		const deletion = store.compareAndSwapRef(
			refName,
			{ type: "direct", hash: fixture.oldHash },
			null,
		);
		await packedLockHeld;
		try {
			const [claimant, lock] = await Promise.all([
				nodeFs.stat(claimantPath),
				nodeFs.stat(packedLockPath),
			]);
			expect(claimant.ino).toBe(lock.ino);
			expect(lock.nlink).toBe(2);
			expect(await nodeFs.readFile(packedLockPath, "utf8")).toBe("");
			const blocked = await git(fixture.root, fixture.env, ["pack-refs", "--all", "--prune"]);
			expect(blocked.exitCode).not.toBe(0);
			expect(blocked.stderr).toContain("packed-refs.lock");
			expect(
				(await git(fixture.root, fixture.env, ["show-ref", "--verify", refName])).exitCode,
			).toBe(0);
		} finally {
			release();
		}

		expect(await deletion).toBe(true);
		expect(await pathExists(packedLockPath)).toBe(false);
		expect(await pathExists(claimantPath)).toBe(false);
		expect(
			(await git(fixture.root, fixture.env, ["show-ref", "--verify", "--quiet", refName])).exitCode,
		).toBe(1);
		expect(
			(await git(fixture.root, fixture.env, ["show-ref", "--verify", "refs/heads/new-loose"]))
				.exitCode,
		).toBe(0);
	});

	test("cleans its named lock when real Git owns packed-refs.lock", async () => {
		const fixture = await repoFixture();
		const gitRef = "refs/heads/git-deletes";
		const justGitRef = "refs/heads/just-git-deletes";
		expect(
			(await git(fixture.root, fixture.env, ["branch", "git-deletes", fixture.oldHash])).exitCode,
		).toBe(0);
		expect(
			(await git(fixture.root, fixture.env, ["branch", "just-git-deletes", fixture.newHash]))
				.exitCode,
		).toBe(0);
		expect((await git(fixture.root, fixture.env, ["pack-refs", "--all", "--prune"])).exitCode).toBe(
			0,
		);
		const gitLock = join(fixture.gitDir, `${gitRef}.lock`);
		const justGitLock = join(fixture.gitDir, `${justGitRef}.lock`);
		const packedLock = join(fixture.gitDir, "packed-refs.lock");
		const prepared = await prepareUpdate(fixture, `delete ${gitRef} ${fixture.oldHash}`, [
			gitLock,
			packedLock,
		]);

		try {
			const fs = durableFileSystemFromNodeFs(nodeFs);
			const mutation = createNativeRefMutation(
				fs,
				{ gitDir: fixture.gitDir, commonDir: fixture.gitDir },
				{ lockTimeoutMs: 0 },
			);
			await expect(
				mutation.compareAndSwapRef(justGitRef, { type: "direct", hash: fixture.newHash }, null),
			).rejects.toBeInstanceOf(NativeRefLockContentionError);
			expect(await pathExists(justGitLock)).toBe(false);
			expect(
				await claimantNames(join(fixture.gitDir, "refs/heads"), "just-git-deletes.lock"),
			).toEqual([]);
			expect(
				(await git(fixture.root, fixture.env, ["show-ref", "--verify", justGitRef])).exitCode,
			).toBe(0);

			const result = await prepared.commit();
			expect(result.exitCode).toBe(0);
		} finally {
			await prepared.abort();
		}

		expect(
			(await git(fixture.root, fixture.env, ["show-ref", "--verify", "--quiet", gitRef])).exitCode,
		).toBe(1);
		expect(
			(await git(fixture.root, fixture.env, ["show-ref", "--verify", justGitRef])).exitCode,
		).toBe(0);
		expect(await pathExists(packedLock)).toBe(false);
	});
});

describe("interop: bulk packed-ref transactions", () => {
	test("respects packed-refs.lock held by a prepared native update", async () => {
		const fixture = await repoFixture();
		const refName = "refs/heads/native-packed-owner";
		expect(
			(await git(fixture.root, fixture.env, ["branch", "native-packed-owner", fixture.oldHash]))
				.exitCode,
		).toBe(0);
		expect((await git(fixture.root, fixture.env, ["pack-refs", "--all", "--prune"])).exitCode).toBe(
			0,
		);
		const prepared = await prepareUpdate(fixture, `delete ${refName} ${fixture.oldHash}`, [
			join(fixture.gitDir, `${refName}.lock`),
			join(fixture.gitDir, "packed-refs.lock"),
		]);

		try {
			const fs = durableFileSystemFromNodeFs(nodeFs);
			await expect(
				writePackedRefsNative(fs, {
					gitDir: fixture.gitDir,
					commonDir: fixture.gitDir,
				}),
			).rejects.toBeInstanceOf(NativeRefLockContentionError);
			expect(
				(await git(fixture.root, fixture.env, ["show-ref", "--verify", refName])).exitCode,
			).toBe(0);
		} finally {
			await prepared.abort();
		}
	});

	test("blocks native pack-refs while just-git owns packed-refs.lock", async () => {
		const fixture = await repoFixture();
		const refName = "refs/heads/pack-me";
		expect(
			(await git(fixture.root, fixture.env, ["branch", "pack-me", fixture.oldHash])).exitCode,
		).toBe(0);

		const packedLockPath = join(fixture.gitDir, "packed-refs.lock");
		const fs = durableFileSystemFromNodeFs(nodeFs);
		const originalLink = fs.link.bind(fs);
		let release!: () => void;
		const mayContinue = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const lockHeld = new Promise<void>((resolve) => {
			reached = resolve;
		});
		fs.link = async (existingPath, newPath) => {
			await originalLink(existingPath, newPath);
			if (newPath === packedLockPath) {
				reached();
				await mayContinue;
			}
		};

		const packing = writePackedRefsNative(fs, {
			gitDir: fixture.gitDir,
			commonDir: fixture.gitDir,
		});
		await lockHeld;
		try {
			const blocked = await git(fixture.root, fixture.env, ["pack-refs", "--all", "--prune"]);
			expect(blocked.exitCode).not.toBe(0);
			expect(blocked.stderr).toContain("packed-refs.lock");
		} finally {
			release();
		}
		await packing;

		expect(await pathExists(packedLockPath)).toBe(false);
		expect(await pathExists(join(fixture.gitDir, refName))).toBe(false);
		expect((await git(fixture.root, fixture.env, ["show-ref", "--verify", refName])).exitCode).toBe(
			0,
		);
	});

	test("keeps a loose value updated by native Git before conditional pruning", async () => {
		const fixture = await repoFixture();
		const refName = "refs/heads/racing-pack";
		const refPath = join(fixture.gitDir, refName);
		const namedLockPath = `${refPath}.lock`;
		expect(
			(await git(fixture.root, fixture.env, ["update-ref", refName, fixture.oldHash])).exitCode,
		).toBe(0);

		const fs = durableFileSystemFromNodeFs(nodeFs);
		const originalLink = fs.link.bind(fs);
		let release!: () => void;
		const mayPrune = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const pruneReached = new Promise<void>((resolve) => {
			reached = resolve;
		});
		fs.link = async (existingPath, newPath) => {
			if (newPath === namedLockPath) {
				reached();
				await mayPrune;
			}
			await originalLink(existingPath, newPath);
		};

		const packing = writePackedRefsNative(fs, {
			gitDir: fixture.gitDir,
			commonDir: fixture.gitDir,
		});
		await pruneReached;
		try {
			const update = await git(fixture.root, fixture.env, [
				"update-ref",
				refName,
				fixture.newHash,
				fixture.oldHash,
			]);
			expect(update.exitCode).toBe(0);
		} finally {
			release();
		}
		await packing;

		expect(await nodeFs.readFile(refPath, "utf8")).toBe(`${fixture.newHash}\n`);
		const packed = await nodeFs.readFile(join(fixture.gitDir, "packed-refs"), "utf8");
		expect(packed).toContain(`${fixture.oldHash} ${refName}\n`);
		expect((await git(fixture.root, fixture.env, ["rev-parse", refName])).stdout.trim()).toBe(
			fixture.newHash,
		);
	});
});
