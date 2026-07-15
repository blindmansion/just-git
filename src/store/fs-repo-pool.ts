import {
	ensureDirectoryDurable,
	removeFileDurable,
	replaceFileDurable,
	withFileLock,
} from "../fs/durable-io.ts";
import type { DurableFileSystem } from "../fs/index.ts";
import { dirname, join, relative } from "../lib/path.ts";
import { sha1 } from "../lib/sha1.ts";
import {
	createBareRepoLayoutInPlace,
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

type PoolOperation =
	| { version: 1; type: "fork"; sourceId: string; targetId: string }
	| { version: 1; type: "delete"; repoId: string; tombstone: string };

/** Create a durable, managed pool of native bare repositories. */
export async function createFsRepoPool(fs: DurableFileSystem, rootDir: string): Promise<RepoPool> {
	const root = requireAbsoluteNormalizedPath(rootDir);
	const controlDir = join(root, ".just-git");
	const reposDir = join(root, "repos");
	const tombstonesDir = join(controlDir, "tombstones");
	const lockPath = join(controlDir, "pool.lock");
	const metadataPath = join(controlDir, "forks.json");
	const operationPath = join(controlDir, "operation.json");

	await ensureDirectoryDurable(fs, controlDir);
	await ensureDirectoryDurable(fs, reposDir);
	await ensureDirectoryDurable(fs, tombstonesDir);

	await withPoolLock(fs, lockPath, async () => {
		if (!(await fs.exists(metadataPath))) {
			await writeMetadata(fs, metadataPath, emptyMetadata());
		}
		await recoverPoolOperation(fs, root, metadataPath, tombstonesDir, operationPath);
		await cleanupAbandonedEntries(
			fs,
			root,
			metadataPath,
			reposDir,
			tombstonesDir,
			controlDir,
			lockPath,
			operationPath,
		);
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
			await withPoolLock(fs, lockPath, async () => {
				if (await fs.exists(finalPath)) throw new Error(`repo '${repoId}' already exists`);
				const shardDir = dirname(finalPath);
				await ensureDirectoryDurable(fs, shardDir);
				const stagePath = join(shardDir, `.stage-${basename(finalPath)}-${nonce()}`);
				let published = false;
				try {
					await createBareRepoLayoutInPlace(fs, stagePath);
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
			await withPoolLock(fs, lockPath, async () => {
				const metadata = await readMetadata();
				const children = childrenOf(metadata, repoId);
				if (children.length > 0) {
					throw new Error(`cannot delete repo '${repoId}': has ${children.length} active fork(s)`);
				}
				if (!(await fs.exists(path))) throw new Error(`repo '${repoId}' not found`);
				await validateBareRepoLayout(fs, path);

				const operation: PoolOperation = {
					version: 1,
					type: "delete",
					repoId,
					tombstone: `${basename(path)}-${nonce()}`,
				};
				await writeOperation(fs, operationPath, operation);
				await finishDeleteOperation(fs, root, metadataPath, tombstonesDir, operation);
				await removeFileDurable(fs, operationPath);
			});
		},

		async fork(sourceId, targetId) {
			const sourcePath = await pathFor(sourceId);
			const targetPath = await pathFor(targetId);
			await withPoolLock(fs, lockPath, async () => {
				if (!(await fs.exists(sourcePath))) throw new Error(`source repo '${sourceId}' not found`);
				if (!(await fs.exists(targetPath))) throw new Error(`repo '${targetId}' not found`);
				await validateBareRepoLayout(fs, sourcePath);
				await validateBareRepoLayout(fs, targetPath);

				const metadata = await readMetadata();
				if (metadata.forks[sourceId] !== undefined) {
					throw new Error(`fork source '${sourceId}' is not a root repository`);
				}
				if (metadata.forks[targetId] !== undefined && metadata.forks[targetId] !== sourceId) {
					throw new Error(`repo '${targetId}' is already a fork`);
				}
				if (sourceId === targetId) throw new Error("a repository cannot fork itself");
				if (metadata.forks[targetId] === sourceId) {
					await finishForkOperation(fs, root, metadataPath, {
						version: 1,
						type: "fork",
						sourceId,
						targetId,
					});
					return;
				}

				const operation: PoolOperation = {
					version: 1,
					type: "fork",
					sourceId,
					targetId,
				};
				await writeOperation(fs, operationPath, operation);
				await finishForkOperation(fs, root, metadataPath, operation);
				await removeFileDurable(fs, operationPath);
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
 * Explicitly recover a pool after the operator has established that no process
 * still owns its durable lock. Recovery removes that lock, then replays any
 * versioned operation manifest before opening the pool.
 */
export async function recoverFsRepoPool(fs: DurableFileSystem, rootDir: string): Promise<RepoPool> {
	const root = requireAbsoluteNormalizedPath(rootDir);
	const controlDir = join(root, ".just-git");
	const lockPath = join(controlDir, "pool.lock");
	if (await fs.exists(lockPath)) await removeFileDurable(fs, lockPath);
	if (await fs.exists(controlDir)) {
		for (const name of await fs.readdir(controlDir)) {
			if (!name.startsWith(`${basename(lockPath)}.tmp-`)) continue;
			await fs.rm(join(controlDir, name), { force: true });
			await fs.fsync(controlDir);
		}
	}
	return createFsRepoPool(fs, root);
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

async function recoverPoolOperation(
	fs: DurableFileSystem,
	root: string,
	metadataPath: string,
	tombstonesDir: string,
	operationPath: string,
): Promise<void> {
	if (!(await fs.exists(operationPath))) return;
	const operation = await loadOperation(fs, operationPath);
	if (operation.type === "fork") {
		await finishForkOperation(fs, root, metadataPath, operation);
	} else {
		await finishDeleteOperation(fs, root, metadataPath, tombstonesDir, operation);
	}
	await removeFileDurable(fs, operationPath);
}

async function finishForkOperation(
	fs: DurableFileSystem,
	root: string,
	metadataPath: string,
	operation: Extract<PoolOperation, { type: "fork" }>,
): Promise<void> {
	const sourcePath = await repoPath(root, operation.sourceId);
	const targetPath = await repoPath(root, operation.targetId);
	if (!(await fs.exists(sourcePath)) || !(await fs.exists(targetPath))) {
		throw new Error(
			`cannot recover filesystem pool fork with a missing repository: '${operation.targetId}' -> '${operation.sourceId}'`,
		);
	}
	await validateBareRepoLayout(fs, sourcePath);
	await validateBareRepoLayout(fs, targetPath);

	const metadata = await loadMetadata(fs, metadataPath);
	if (metadata.forks[operation.sourceId] !== undefined) {
		throw new Error(`cannot recover fork from non-root repo '${operation.sourceId}'`);
	}
	const existingParent = metadata.forks[operation.targetId];
	if (existingParent !== undefined && existingParent !== operation.sourceId) {
		throw new Error(
			`cannot recover fork '${operation.targetId}': metadata names parent '${existingParent}'`,
		);
	}

	const alternatesPath = join(targetPath, "objects", "info", "alternates");
	const alternate = `${relative(join(targetPath, "objects"), join(sourcePath, "objects"))}\n`;
	if (!(await fs.exists(alternatesPath)) || (await fs.readFile(alternatesPath)) !== alternate) {
		await replaceFileDurable(fs, alternatesPath, alternate);
	}
	if (existingParent === undefined) {
		metadata.forks[operation.targetId] = operation.sourceId;
		await writeMetadata(fs, metadataPath, metadata);
	}
}

async function finishDeleteOperation(
	fs: DurableFileSystem,
	root: string,
	metadataPath: string,
	tombstonesDir: string,
	operation: Extract<PoolOperation, { type: "delete" }>,
): Promise<void> {
	const path = await repoPath(root, operation.repoId);
	if (
		!operation.tombstone.startsWith(`${basename(path)}-`) ||
		!/^[a-z0-9.-]+$/.test(operation.tombstone)
	) {
		throw new Error("malformed filesystem repository pool operation manifest");
	}
	const tombstone = join(tombstonesDir, operation.tombstone);
	const liveExists = await fs.exists(path);
	const tombstoneExists = await fs.exists(tombstone);

	if (liveExists) await validateBareRepoLayout(fs, path);
	if (liveExists && tombstoneExists) {
		// A cross-directory rename can durably appear in both parents until
		// the source parent is fsynced. Keep the recognized tombstone.
		await fs.rm(path, { recursive: true });
		await fs.fsync(dirname(path));
	} else if (liveExists) {
		await fs.rename(path, tombstone);
		// Persist the recovery copy before publishing removal from the live shard.
		await fs.fsync(tombstonesDir);
		await fs.fsync(dirname(path));
	}

	const metadata = await loadMetadata(fs, metadataPath);
	const children = childrenOf(metadata, operation.repoId);
	if (children.length > 0) {
		throw new Error(
			`cannot recover deletion of repo '${operation.repoId}': has ${children.length} active fork(s)`,
		);
	}
	if (metadata.forks[operation.repoId] !== undefined) {
		delete metadata.forks[operation.repoId];
		await writeMetadata(fs, metadataPath, metadata);
	}
	if (await fs.exists(tombstone)) {
		await fs.rm(tombstone, { recursive: true });
		await fs.fsync(tombstonesDir);
	}
}

async function cleanupAbandonedEntries(
	fs: DurableFileSystem,
	root: string,
	metadataPath: string,
	reposDir: string,
	tombstonesDir: string,
	controlDir: string,
	lockPath: string,
	operationPath: string,
): Promise<void> {
	const metadata = await loadMetadata(fs, metadataPath);
	const relatedPaths = await Promise.all(
		[...new Set([...Object.keys(metadata.forks), ...Object.values(metadata.forks)])].map((repoId) =>
			repoPath(root, repoId),
		),
	);
	for (const name of await fs.readdir(tombstonesDir)) {
		if (!/^r-[a-z2-7]+\.git-[a-z0-9-]+$/.test(name)) continue;
		if (relatedPaths.some((path) => name.startsWith(`${basename(path)}-`))) {
			throw new Error(
				`filesystem repository pool has an ambiguous fork tombstone requiring recovery: ${JSON.stringify(name)}`,
			);
		}
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
	for (const name of await fs.readdir(controlDir)) {
		if (
			name.startsWith(`${basename(metadataPath)}.tmp-`) ||
			name.startsWith(`${basename(lockPath)}.tmp-`) ||
			name.startsWith(`${basename(operationPath)}.tmp-`)
		) {
			await fs.rm(join(controlDir, name), { force: true });
			await fs.fsync(controlDir);
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

async function loadOperation(fs: DurableFileSystem, path: string): Promise<PoolOperation> {
	let value: unknown;
	try {
		value = JSON.parse(await fs.readFile(path));
	} catch {
		throw new Error(
			`malformed filesystem repository pool operation manifest at ${JSON.stringify(path)}`,
		);
	}
	if (
		typeof value !== "object" ||
		value === null ||
		(value as { version?: unknown }).version !== 1
	) {
		throw new Error(
			`malformed filesystem repository pool operation manifest at ${JSON.stringify(path)}`,
		);
	}
	const operation = value as Record<string, unknown>;
	if (
		operation.type === "fork" &&
		typeof operation.sourceId === "string" &&
		typeof operation.targetId === "string" &&
		isValidRepoId(operation.sourceId) &&
		isValidRepoId(operation.targetId) &&
		operation.sourceId !== operation.targetId
	) {
		return {
			version: 1,
			type: "fork",
			sourceId: operation.sourceId,
			targetId: operation.targetId,
		};
	}
	if (
		operation.type === "delete" &&
		typeof operation.repoId === "string" &&
		typeof operation.tombstone === "string" &&
		isValidRepoId(operation.repoId)
	) {
		return {
			version: 1,
			type: "delete",
			repoId: operation.repoId,
			tombstone: operation.tombstone,
		};
	}
	throw new Error(
		`malformed filesystem repository pool operation manifest at ${JSON.stringify(path)}`,
	);
}

async function writeOperation(
	fs: DurableFileSystem,
	path: string,
	operation: PoolOperation,
): Promise<void> {
	await replaceFileDurable(fs, path, `${JSON.stringify(operation, null, 2)}\n`);
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

async function withPoolLock<T>(
	fs: DurableFileSystem,
	lockPath: string,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await withFileLock(fs, lockPath, fn);
	} catch (error) {
		if (isAlreadyExistsError(error)) throw stalePoolLockError(lockPath);
		throw error;
	}
}

function stalePoolLockError(lockPath: string): Error {
	return new Error(
		`EEXIST: filesystem repository pool lock is already present at ${JSON.stringify(lockPath)}; explicit stale-lock recovery is required`,
	);
}

function isAlreadyExistsError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ("code" in error && (error as { code?: unknown }).code === "EEXIST") return true;
	return "message" in error && /^EEXIST\b/.test(String((error as { message?: unknown }).message));
}
