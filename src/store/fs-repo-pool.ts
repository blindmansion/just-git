import { ensureDirectoryDurable, replaceFileDurable, withFileLock } from "../fs/durable-io.ts";
import type { DurableFileSystem } from "../fs/index.ts";
import { dirname, join, relative } from "../lib/path.ts";
import { sha1 } from "../lib/sha1.ts";
import {
	createBareRepoLayout,
	createFsRepoStorage,
	requireAbsoluteNormalizedPath,
	validateBareRepoLayout,
} from "./fs-repo-storage.ts";
import { isValidRepoId } from "./repo-id.ts";
import type { RepoPool } from "./repo-pool.ts";

const METADATA_VERSION = 1;
const MAX_COMPONENT_BYTES = 255;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const encoder = new TextEncoder();

interface ForkMetadata {
	version: 1;
	forks: Record<string, string>;
}

/** Create a durable, managed pool of native bare repositories. */
export async function createFsRepoPool(fs: DurableFileSystem, rootDir: string): Promise<RepoPool> {
	const root = requireAbsoluteNormalizedPath(rootDir);
	const controlDir = join(root, ".just-git");
	const reposDir = join(root, "repos");
	const tombstonesDir = join(controlDir, "tombstones");
	const lockPath = join(controlDir, "pool.lock");
	const metadataPath = join(controlDir, "forks.json");

	await ensureDirectoryDurable(fs, controlDir);
	await ensureDirectoryDurable(fs, reposDir);
	await ensureDirectoryDurable(fs, tombstonesDir);

	await withFileLock(fs, lockPath, async () => {
		if (!(await fs.exists(metadataPath))) {
			await writeMetadata(fs, metadataPath, emptyMetadata());
		}
		await cleanupAbandonedEntries(fs, reposDir, tombstonesDir);
		await validatePool(fs, root, metadataPath);
	});

	const pathFor = (repoId: string) => repoPath(root, repoId);
	const readMetadata = () => loadMetadata(fs, metadataPath);

	return {
		async hasRepo(repoId) {
			const path = await pathFor(repoId);
			if (!(await fs.exists(path))) return false;
			await validateBareRepoLayout(fs, path);
			return true;
		},

		async createRepo(repoId) {
			const finalPath = await pathFor(repoId);
			await withFileLock(fs, lockPath, async () => {
				if (await fs.exists(finalPath)) throw new Error(`repo '${repoId}' already exists`);
				const shardDir = dirname(finalPath);
				await ensureDirectoryDurable(fs, shardDir);
				const stagePath = join(shardDir, `.stage-${basename(finalPath)}-${nonce()}`);
				let published = false;
				try {
					await createBareRepoLayout(fs, stagePath);
					await fs.fsync(stagePath);
					await fs.rename(stagePath, finalPath);
					published = true;
					await fs.fsync(shardDir);
				} finally {
					if (!published) {
						await fs.rm(stagePath, { recursive: true, force: true });
						await fs.fsync(shardDir);
					}
				}
			});
		},

		async open(repoId) {
			const path = await pathFor(repoId);
			if (!(await fs.exists(path))) throw new Error(`repo '${repoId}' not found`);
			await validateBareRepoLayout(fs, path);
			return createFsRepoStorage(fs, path);
		},

		async deleteRepo(repoId) {
			const path = await pathFor(repoId);
			await withFileLock(fs, lockPath, async () => {
				const metadata = await readMetadata();
				const children = childrenOf(metadata, repoId);
				if (children.length > 0) {
					throw new Error(`cannot delete repo '${repoId}': has ${children.length} active fork(s)`);
				}
				if (!(await fs.exists(path))) throw new Error(`repo '${repoId}' not found`);
				await validateBareRepoLayout(fs, path);

				const tombstone = join(tombstonesDir, `${basename(path)}-${nonce()}`);
				await fs.rename(path, tombstone);
				await fs.fsync(dirname(path));
				await fs.fsync(tombstonesDir);

				if (metadata.forks[repoId] !== undefined) {
					delete metadata.forks[repoId];
					await writeMetadata(fs, metadataPath, metadata);
				}
				await fs.rm(tombstone, { recursive: true });
				await fs.fsync(tombstonesDir);
			});
		},

		async fork(sourceId, targetId) {
			const sourcePath = await pathFor(sourceId);
			const targetPath = await pathFor(targetId);
			await withFileLock(fs, lockPath, async () => {
				if (!(await fs.exists(sourcePath))) throw new Error(`source repo '${sourceId}' not found`);
				if (!(await fs.exists(targetPath))) throw new Error(`repo '${targetId}' not found`);
				await validateBareRepoLayout(fs, sourcePath);
				await validateBareRepoLayout(fs, targetPath);

				const metadata = await readMetadata();
				if (metadata.forks[sourceId] !== undefined) {
					throw new Error(`fork source '${sourceId}' is not a root repository`);
				}
				if (metadata.forks[targetId] !== undefined) {
					throw new Error(`repo '${targetId}' is already a fork`);
				}
				if (sourceId === targetId) throw new Error("a repository cannot fork itself");

				const alternatesPath = join(targetPath, "objects", "info", "alternates");
				const alternate = relative(join(targetPath, "objects"), join(sourcePath, "objects"));
				await replaceFileDurable(fs, alternatesPath, `${alternate}\n`);
				metadata.forks[targetId] = sourceId;
				await writeMetadata(fs, metadataPath, metadata);
			});
		},

		async parentOf(repoId) {
			requireRepoId(repoId);
			return (await readMetadata()).forks[repoId] ?? null;
		},

		async forksOf(repoId) {
			requireRepoId(repoId);
			return childrenOf(await readMetadata(), repoId);
		},
	};
}

/**
 * Expose one existing bare repository through a fixed logical repository ID.
 * Lifecycle and fork operations are deliberately unsupported.
 */
export async function createFsSingleRepoPool(
	fs: DurableFileSystem,
	repoId: string,
	repoDir: string,
): Promise<RepoPool> {
	requireRepoId(repoId);
	const root = requireAbsoluteNormalizedPath(repoDir);
	if (!(await fs.exists(root)))
		throw new Error(`repository path does not exist: ${JSON.stringify(root)}`);
	await validateBareRepoLayout(fs, root);

	const unsupported = async (): Promise<never> => {
		throw new Error("single-repository filesystem pool does not support lifecycle mutations");
	};
	return {
		async hasRepo(id) {
			requireRepoId(id);
			return id === repoId;
		},
		createRepo: unsupported,
		deleteRepo: unsupported,
		async open(id) {
			requireRepoId(id);
			if (id !== repoId) throw new Error(`repo '${id}' not found`);
			return createFsRepoStorage(fs, root);
		},
	};
}

async function validatePool(
	fs: DurableFileSystem,
	root: string,
	metadataPath: string,
): Promise<void> {
	const metadata = await loadMetadata(fs, metadataPath);
	const forkPaths = new Set<string>();
	for (const [childId, rootId] of Object.entries(metadata.forks)) {
		if (!isValidRepoId(childId) || !isValidRepoId(rootId) || childId === rootId) {
			throw new Error("malformed filesystem repository pool fork metadata");
		}
		if (metadata.forks[rootId] !== undefined) {
			throw new Error(`fork metadata root '${rootId}' is itself a fork`);
		}
		const childPath = await repoPath(root, childId);
		const rootPath = await repoPath(root, rootId);
		forkPaths.add(childPath);
		if (!(await fs.exists(childPath)) || !(await fs.exists(rootPath))) {
			throw new Error(`fork metadata references a missing repository: '${childId}' -> '${rootId}'`);
		}
		await validateBareRepoLayout(fs, childPath);
		await validateBareRepoLayout(fs, rootPath);
		const alternatesPath = join(childPath, "objects", "info", "alternates");
		const expected = `${relative(join(childPath, "objects"), join(rootPath, "objects"))}\n`;
		if (!(await fs.exists(alternatesPath)) || (await fs.readFile(alternatesPath)) !== expected) {
			throw new Error(`fork metadata/alternates inconsistency for repo '${childId}'`);
		}
	}

	const reposDir = join(root, "repos");
	for (const shard of await fs.readdir(reposDir)) {
		if (!/^[0-9a-f]{2}$/.test(shard)) continue;
		const shardDir = join(reposDir, shard);
		if (!(await fs.stat(shardDir)).isDirectory) continue;
		for (const name of await fs.readdir(shardDir)) {
			if (!/^r-[a-z2-7]+\.git$/.test(name)) continue;
			const repoDir = join(shardDir, name);
			const alternatesPath = join(repoDir, "objects", "info", "alternates");
			if ((await fs.exists(alternatesPath)) && !forkPaths.has(repoDir)) {
				throw new Error(
					`repository alternates missing from fork metadata: ${JSON.stringify(repoDir)}`,
				);
			}
		}
	}
}

async function cleanupAbandonedEntries(
	fs: DurableFileSystem,
	reposDir: string,
	tombstonesDir: string,
): Promise<void> {
	for (const name of await fs.readdir(tombstonesDir)) {
		if (!/^r-[a-z2-7]+\.git-[a-z0-9-]+$/.test(name)) continue;
		await fs.rm(join(tombstonesDir, name), { recursive: true });
		await fs.fsync(tombstonesDir);
	}
	for (const shard of await fs.readdir(reposDir)) {
		if (!/^[0-9a-f]{2}$/.test(shard)) continue;
		const shardDir = join(reposDir, shard);
		if (!(await fs.stat(shardDir)).isDirectory) continue;
		for (const name of await fs.readdir(shardDir)) {
			if (!/^\.stage-r-[a-z2-7]+\.git-[a-z0-9-]+$/.test(name)) continue;
			await fs.rm(join(shardDir, name), { recursive: true });
			await fs.fsync(shardDir);
		}
	}
}

async function repoPath(root: string, repoId: string): Promise<string> {
	const bytes = requireRepoId(repoId);
	const encoded = encodeBase32(bytes);
	const component = `r-${encoded}.git`;
	if (encoder.encode(component).byteLength > MAX_COMPONENT_BYTES) {
		throw new Error(
			`repository ID is too long for a filesystem component: ${JSON.stringify(repoId)}`,
		);
	}
	const hash = await sha1(bytes);
	return join(root, "repos", hash.slice(0, 2), component);
}

function requireRepoId(repoId: string): Uint8Array {
	if (!isValidRepoId(repoId)) throw new Error(`invalid repository ID: ${JSON.stringify(repoId)}`);
	return encoder.encode(repoId);
}

function encodeBase32(bytes: Uint8Array): string {
	let value = 0;
	let bits = 0;
	let result = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return result;
}

async function loadMetadata(fs: DurableFileSystem, path: string): Promise<ForkMetadata> {
	let value: unknown;
	try {
		value = JSON.parse(await fs.readFile(path));
	} catch {
		throw new Error(`malformed filesystem repository pool metadata at ${JSON.stringify(path)}`);
	}
	if (
		typeof value !== "object" ||
		value === null ||
		(value as { version?: unknown }).version !== METADATA_VERSION ||
		typeof (value as { forks?: unknown }).forks !== "object" ||
		(value as { forks?: unknown }).forks === null ||
		Array.isArray((value as { forks?: unknown }).forks)
	) {
		throw new Error(`malformed filesystem repository pool metadata at ${JSON.stringify(path)}`);
	}
	for (const entry of Object.values((value as { forks: Record<string, unknown> }).forks)) {
		if (typeof entry !== "string") {
			throw new Error(`malformed filesystem repository pool metadata at ${JSON.stringify(path)}`);
		}
	}
	const forks = Object.assign(
		Object.create(null) as Record<string, string>,
		(value as { forks: Record<string, string> }).forks,
	);
	return { version: METADATA_VERSION, forks };
}

async function writeMetadata(
	fs: DurableFileSystem,
	path: string,
	metadata: ForkMetadata,
): Promise<void> {
	await replaceFileDurable(fs, path, `${JSON.stringify(metadata, null, 2)}\n`);
}

function emptyMetadata(): ForkMetadata {
	return { version: METADATA_VERSION, forks: Object.create(null) as Record<string, string> };
}

function childrenOf(metadata: ForkMetadata, repoId: string): string[] {
	return Object.entries(metadata.forks)
		.filter(([, rootId]) => rootId === repoId)
		.map(([childId]) => childId)
		.sort();
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function nonce(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
