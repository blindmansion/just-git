import { describe, expect, test } from "bun:test";
import { replaceFileDurable } from "../../../src/fs/durable-io.ts";
import { sha1 } from "../../../src/lib/sha1.ts";
import { createFsRepoPool, recoverFsRepoPool } from "../../../src/store/fs-repo-pool.ts";
import {
	createBareRepoLayoutInPlace,
	validateBareRepoLayout,
} from "../../../src/store/fs-repo-storage.ts";
import { replayCrashCuts } from "./crash-harness.ts";
import type { CrashableDurableFileSystem } from "./crashable-durable-fs.ts";
import { assertBareRepoOrAbsent, assertPoolMetadataValid } from "./invariants.ts";

const ROOT = "/pool";
const CONTROL = `${ROOT}/.just-git`;
const METADATA = `${CONTROL}/forks.json`;
const LOCK = `${CONTROL}/pool.lock`;
const TOMBSTONES = `${CONTROL}/tombstones`;

describe("filesystem repository pool crash durability", () => {
	test("bootstrap leaves absent or complete metadata and explicitly reports stale locks", async () => {
		await replayCrashCuts({
			setup: async (fs) => {
				await fs.mkdir(ROOT);
			},
			operation: (fs) => createFsRepoPool(fs, ROOT),
			verifyCut: async ({ fs }) => {
				await assertPoolMetadataValid(fs, METADATA);
				if (await fs.exists(LOCK)) {
					await expect(createFsRepoPool(fs, ROOT)).rejects.toThrow(
						"explicit stale-lock recovery is required",
					);
				}
			},
			verifySuccess: async (fs) => {
				expect(await fs.exists(LOCK)).toBe(false);
				expect(await assertPoolMetadataValid(fs, METADATA)).toEqual({
					version: 1,
					forks: {},
				});
			},
			retry: async (fs) => {
				await recoverFsRepoPool(fs, ROOT);
				const rebooted = fs.reboot();
				expect(await rebooted.exists(LOCK)).toBe(false);
				expect(await assertPoolMetadataValid(rebooted, METADATA)).toEqual({
					version: 1,
					forks: {},
				});
			},
		});
	});

	test("create publishes no incomplete final repository and startup removes stages", async () => {
		const repoPath = await pathFor("demo");
		await replayCrashCuts({
			setup: (fs) => createFsRepoPool(fs, ROOT).then(() => undefined),
			operation: async (fs) => {
				await (await createFsRepoPool(fs, ROOT)).createRepo("demo");
			},
			verifyCut: async ({ fs }) => {
				await assertBareRepoOrAbsent(fs, repoPath);
				await assertSafeStages(fs, repoPath);
			},
			verifySuccess: async (fs) => {
				await validateBareRepoLayout(fs, repoPath);
				await assertNoStages(fs, repoPath);
			},
			retry: async (fs) => {
				const pool = await recoverFsRepoPool(fs, ROOT);
				if (!(await pool.hasRepo("demo"))) await pool.createRepo("demo");
				const rebooted = fs.reboot();
				await validateBareRepoLayout(rebooted, repoPath);
				await assertNoStages(rebooted, repoPath);
			},
		});
	});

	test("root deletion keeps data live or recoverable until deletion commits", async () => {
		const repoPath = await pathFor("demo");
		await replayCrashCuts({
			setup: async (fs) => {
				const pool = await createFsRepoPool(fs, ROOT);
				await pool.createRepo("demo");
			},
			operation: async (fs) => {
				await (await createFsRepoPool(fs, ROOT)).deleteRepo("demo");
			},
			verifyCut: async ({ fs }) => {
				await assertDeletionStateSafe(fs, repoPath);
			},
			verifySuccess: async (fs) => {
				expect(await fs.exists(repoPath)).toBe(false);
				expect(await fs.readdir(TOMBSTONES)).toEqual([]);
			},
			retry: async (fs) => {
				const pool = await recoverFsRepoPool(fs, ROOT);
				if (await pool.hasRepo("demo")) await pool.deleteRepo("demo");
				expect(await pool.hasRepo("demo")).toBe(false);
				const rebooted = fs.reboot();
				expect(await rebooted.exists(repoPath)).toBe(false);
				expect(await rebooted.readdir(TOMBSTONES)).toEqual([]);
			},
		});
	});

	test("fork publication recovers alternates before metadata becomes visible", async () => {
		const sourcePath = await pathFor("upstream");
		const targetPath = await pathFor("child");
		const alternatesPath = `${targetPath}/objects/info/alternates`;
		const expectedAlternate = relativeObjects(targetPath, sourcePath);

		await replayCrashCuts({
			setup: async (fs) => {
				const pool = await createFsRepoPool(fs, ROOT);
				await pool.createRepo("upstream");
				await pool.createRepo("child");
			},
			operation: async (fs) => {
				await (await createFsRepoPool(fs, ROOT)).fork?.("upstream", "child");
			},
			verifyCut: async ({ fs }) => {
				const metadata = await assertPoolMetadataValid(fs, METADATA);
				if (metadata?.forks.child === "upstream") {
					expect(await fs.readFile(alternatesPath)).toBe(expectedAlternate);
				}
				if (await fs.exists(alternatesPath)) {
					expect(await fs.readFile(alternatesPath)).toBe(expectedAlternate);
				}
			},
			verifySuccess: async (fs) => {
				expect((await assertPoolMetadataValid(fs, METADATA))?.forks).toEqual({
					child: "upstream",
				});
				expect(await fs.readFile(alternatesPath)).toBe(expectedAlternate);
			},
			retry: async (fs) => {
				const pool = await recoverFsRepoPool(fs, ROOT);
				if ((await pool.parentOf?.("child")) === null) {
					await pool.fork?.("upstream", "child");
				}
				expect(await pool.parentOf?.("child")).toBe("upstream");
				expect(await fs.readFile(alternatesPath)).toBe(expectedAlternate);
			},
		});
	});

	test("fork-child deletion reconciles metadata before discarding its tombstone", async () => {
		const childPath = await pathFor("child");
		await replayCrashCuts({
			setup: async (fs) => {
				const pool = await createFsRepoPool(fs, ROOT);
				await pool.createRepo("upstream");
				await pool.createRepo("child");
				await pool.fork?.("upstream", "child");
			},
			operation: async (fs) => {
				await (await createFsRepoPool(fs, ROOT)).deleteRepo("child");
			},
			verifyCut: async ({ fs }) => {
				await assertDeletionStateSafe(fs, childPath);
				const metadata = await assertPoolMetadataValid(fs, METADATA);
				if (metadata?.forks.child === "upstream" && !(await fs.exists(childPath))) {
					expect(await fs.readdir(TOMBSTONES)).not.toEqual([]);
					expect(await fs.exists(`${CONTROL}/operation.json`)).toBe(true);
				}
			},
			verifySuccess: async (fs) => {
				expect((await assertPoolMetadataValid(fs, METADATA))?.forks).toEqual({});
				expect(await fs.exists(childPath)).toBe(false);
			},
			retry: async (fs) => {
				const pool = await recoverFsRepoPool(fs, ROOT);
				if (await pool.hasRepo("child")) await pool.deleteRepo("child");
				expect(await pool.parentOf?.("child")).toBeNull();
				expect(await pool.hasRepo("child")).toBe(false);
				expect(await fs.readdir(TOMBSTONES)).toEqual([]);
			},
		});
	});

	test("startup cleans recognized stages, root tombstones, and replacement temps", async () => {
		const fs = await readyPool();
		const pool = await createFsRepoPool(fs, ROOT);
		await pool.createRepo("orphan");
		const orphanPath = await pathFor("orphan");
		const orphanTombstone = `${TOMBSTONES}/${orphanPath.slice(orphanPath.lastIndexOf("/") + 1)}-dead`;
		await fs.rename(orphanPath, orphanTombstone);
		await fs.fsync(TOMBSTONES);
		await fs.fsync(orphanPath.slice(0, orphanPath.lastIndexOf("/")));

		const demoPath = await pathFor("demo");
		const shard = demoPath.slice(0, demoPath.lastIndexOf("/"));
		await fs.mkdir(shard, { recursive: true });
		await fs.fsync(`${ROOT}/repos`);
		const stage = `${shard}/.stage-${demoPath.slice(demoPath.lastIndexOf("/") + 1)}-dead`;
		await createBareRepoLayoutInPlace(fs, stage);
		await replaceFileDurable(fs, `${METADATA}.tmp-abandoned`, "{}");
		await replaceFileDurable(fs, `${LOCK}.tmp-abandoned`, "");
		await replaceFileDurable(fs, `${CONTROL}/operation.json.tmp-abandoned`, "{}");
		fs.checkpoint();

		await createFsRepoPool(fs, ROOT);
		expect(await fs.exists(orphanTombstone)).toBe(false);
		expect(await fs.exists(stage)).toBe(false);
		expect(await fs.exists(`${METADATA}.tmp-abandoned`)).toBe(false);
		expect(await fs.exists(`${LOCK}.tmp-abandoned`)).toBe(false);
		expect(await fs.exists(`${CONTROL}/operation.json.tmp-abandoned`)).toBe(false);
	});

	test("startup detects alternates without metadata without mutating them", async () => {
		const fs = await readyPool();
		const pool = await createFsRepoPool(fs, ROOT);
		await pool.createRepo("upstream");
		await pool.createRepo("child");
		const sourcePath = await pathFor("upstream");
		const childPath = await pathFor("child");
		const alternatesPath = `${childPath}/objects/info/alternates`;
		const alternate = relativeObjects(childPath, sourcePath);
		await replaceFileDurable(fs, alternatesPath, alternate);
		fs.checkpoint();

		await expect(createFsRepoPool(fs, ROOT)).rejects.toThrow(
			"alternates missing from fork metadata",
		);
		expect(await fs.readFile(alternatesPath)).toBe(alternate);
	});

	test("startup rejects missing repositories named by fork metadata", async () => {
		const fs = await readyPool();
		const pool = await createFsRepoPool(fs, ROOT);
		await pool.createRepo("upstream");
		await pool.createRepo("child");
		await pool.fork?.("upstream", "child");
		const childPath = await pathFor("child");
		await fs.rm(childPath, { recursive: true });
		await fs.fsync(childPath.slice(0, childPath.lastIndexOf("/")));
		fs.checkpoint();

		expect(createFsRepoPool(fs, ROOT)).rejects.toThrow("missing repository");
		expect((await assertPoolMetadataValid(fs, METADATA))?.forks.child).toBe("upstream");
	});

	test("startup preserves an ambiguous child tombstone without a manifest", async () => {
		const fs = await readyPool();
		const pool = await createFsRepoPool(fs, ROOT);
		await pool.createRepo("upstream");
		await pool.createRepo("child");
		await pool.fork?.("upstream", "child");
		const childPath = await pathFor("child");
		const tombstoneName = `${childPath.slice(childPath.lastIndexOf("/") + 1)}-legacy`;
		const tombstone = `${TOMBSTONES}/${tombstoneName}`;
		await fs.rename(childPath, tombstone);
		await fs.fsync(TOMBSTONES);
		await fs.fsync(childPath.slice(0, childPath.lastIndexOf("/")));
		fs.checkpoint();

		expect(createFsRepoPool(fs, ROOT)).rejects.toThrow(
			"ambiguous fork tombstone requiring recovery",
		);
		expect(await fs.exists(tombstone)).toBe(true);
		expect((await assertPoolMetadataValid(fs, METADATA))?.forks.child).toBe("upstream");
	});

	test("ordinary startup replays a manifest when no stale lock remains", async () => {
		const fs = await readyPool();
		const pool = await createFsRepoPool(fs, ROOT);
		await pool.createRepo("upstream");
		await pool.createRepo("child");
		await replaceFileDurable(
			fs,
			`${CONTROL}/operation.json`,
			`${JSON.stringify({
				version: 1,
				type: "fork",
				sourceId: "upstream",
				targetId: "child",
			})}\n`,
		);
		fs.checkpoint();

		const recovered = await createFsRepoPool(fs, ROOT);
		expect(await recovered.parentOf?.("child")).toBe("upstream");
		expect(await fs.exists(`${CONTROL}/operation.json`)).toBe(false);
	});

	test("startup reports malformed operation manifests without guessing", async () => {
		const fs = await readyPool();
		const operationPath = `${CONTROL}/operation.json`;
		await replaceFileDurable(fs, operationPath, '{"version":99,"type":"delete"}\n');
		fs.checkpoint();

		expect(createFsRepoPool(fs, ROOT)).rejects.toThrow("malformed");
		expect(await fs.readFile(operationPath)).toBe('{"version":99,"type":"delete"}\n');
	});

	test("explicit recovery is required before breaking a durable pool lock", async () => {
		const fs = await readyPool();
		await replaceFileDurable(fs, LOCK, "");
		fs.checkpoint();

		expect(createFsRepoPool(fs, ROOT)).rejects.toThrow("explicit stale-lock recovery is required");
		expect(await fs.exists(LOCK)).toBe(true);

		const pool = await recoverFsRepoPool(fs, ROOT);
		await pool.createRepo("demo");
		expect(await pool.hasRepo("demo")).toBe(true);
	});
});

async function readyPool(): Promise<CrashableDurableFileSystem> {
	const { CrashableDurableFileSystem } = await import("./crashable-durable-fs.ts");
	const fs = new CrashableDurableFileSystem();
	await createFsRepoPool(fs, ROOT);
	fs.checkpoint();
	return fs;
}

async function pathFor(repoId: string): Promise<string> {
	const encoded = base32(repoId);
	return `${ROOT}/repos/${(await sha1(new TextEncoder().encode(repoId))).slice(0, 2)}/r-${encoded}.git`;
}

function base32(value: string): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let accumulator = 0;
	let bits = 0;
	let result = "";
	for (const byte of new TextEncoder().encode(value)) {
		accumulator = (accumulator << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			result += alphabet[(accumulator >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) result += alphabet[(accumulator << (5 - bits)) & 31];
	return result;
}

function relativeObjects(childPath: string, sourcePath: string): string {
	const childParts = `${childPath}/objects`.split("/").filter(Boolean);
	const sourceParts = `${sourcePath}/objects`.split("/").filter(Boolean);
	let common = 0;
	while (childParts[common] === sourceParts[common]) common++;
	return `${[...childParts.slice(common).map(() => ".."), ...sourceParts.slice(common)].join("/")}\n`;
}

async function assertSafeStages(fs: CrashableDurableFileSystem, repoPath: string): Promise<void> {
	const shard = repoPath.slice(0, repoPath.lastIndexOf("/"));
	if (!(await fs.exists(shard))) return;
	for (const name of await fs.readdir(shard)) {
		if (repoPath.endsWith(`/${name}`)) continue;
		expect(name).toMatch(/^\.stage-r-[a-z2-7]+\.git-[a-z0-9-]+$/);
	}
}

async function assertNoStages(fs: CrashableDurableFileSystem, repoPath: string): Promise<void> {
	const shard = repoPath.slice(0, repoPath.lastIndexOf("/"));
	expect((await fs.readdir(shard)).filter((name) => name.startsWith(".stage-"))).toEqual([]);
}

async function assertDeletionStateSafe(
	fs: CrashableDurableFileSystem,
	repoPath: string,
): Promise<void> {
	const tombstones = (await fs.exists(TOMBSTONES)) ? await fs.readdir(TOMBSTONES) : [];
	const matching = tombstones.filter((name) =>
		name.startsWith(`${repoPath.slice(repoPath.lastIndexOf("/") + 1)}-`),
	);
	expect(matching.length).toBeLessThanOrEqual(1);
	expect((await fs.exists(repoPath)) || matching.length === 1 || tombstones.length === 0).toBe(
		true,
	);
	if (await fs.exists(repoPath)) await validateBareRepoLayout(fs, repoPath);
	if (matching[0]) await validateBareRepoLayout(fs, `${TOMBSTONES}/${matching[0]}`);
}
