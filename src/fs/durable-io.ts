import { isDurable, type DurableFileSystem, type FileSystem } from "./index.ts";

export type FileContent = string | Uint8Array;

let tempSequence = 0;
const lockQueues = new Map<string, Promise<unknown>>();

/**
 * Create a directory hierarchy and durably publish every newly-added entry.
 */
export async function ensureDirectoryDurable(fs: DurableFileSystem, path: string): Promise<void> {
	const missing: string[] = [];
	let current = trimTrailingSlashes(path);

	while (!(await fs.exists(current))) {
		if (current === "/") break;
		missing.push(current);
		const parent = parentDir(current);
		if (parent === current) break;
		current = parent;
	}

	for (let i = missing.length - 1; i >= 0; i--) {
		const dir = missing[i]!;
		try {
			await fs.mkdir(dir);
		} catch (error) {
			// Another writer may have published the directory after our exists
			// check. Accept only that race; preserve all other mkdir failures.
			if (!isAlreadyExistsError(error) || !(await isDirectory(fs, dir))) {
				throw error;
			}
		}
		await fs.fsync(parentDir(dir));
	}
}

/**
 * Atomically replace a file after its new contents are stable.
 */
export async function replaceFileDurable(
	fs: DurableFileSystem,
	path: string,
	content: FileContent,
): Promise<void> {
	const parent = parentDir(path);
	await ensureDirectoryDurable(fs, parent);
	const temp = tempPath(path);
	let renamed = false;

	try {
		await fs.writeFile(temp, content);
		await fs.fsync(temp);
		await fs.rename(temp, path);
		renamed = true;
		await fs.fsync(parent);
	} finally {
		if (!renamed) await fs.rm(temp, { force: true });
	}
}

/**
 * Durably install an immutable file, returning whether this call won the
 * exclusive-create race.
 */
export async function createFileDurable(
	fs: DurableFileSystem,
	path: string,
	content: FileContent,
): Promise<boolean> {
	const parent = parentDir(path);
	await ensureDirectoryDurable(fs, parent);
	const temp = tempPath(path);

	try {
		await fs.writeFile(temp, content);
		await fs.fsync(temp);
		try {
			await fs.link(temp, path);
		} catch (error) {
			if (isAlreadyExistsError(error)) return false;
			throw error;
		}
		await fs.fsync(parent);
		return true;
	} finally {
		await fs.rm(temp, { force: true });
	}
}

/** Remove a file if present and durably publish the removal. */
export async function removeFileDurable(fs: DurableFileSystem, path: string): Promise<boolean> {
	if (!(await fs.exists(path))) return false;
	await fs.rm(path);
	await fs.fsync(parentDir(path));
	return true;
}

/**
 * Run a callback while holding an exclusive hard-link lock.
 *
 * Calls in this process queue by lock path. A lock held by another process is
 * reported as an ordinary EEXIST-style acquisition failure.
 */
export function withFileLock<T>(
	fs: DurableFileSystem,
	lockPath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = lockQueues.get(lockPath) ?? Promise.resolve();
	const result = previous.then(
		() => withFileLockUnsafe(fs, lockPath, fn),
		() => withFileLockUnsafe(fs, lockPath, fn),
	);
	lockQueues.set(lockPath, result);
	const cleanup = () => {
		if (lockQueues.get(lockPath) === result) lockQueues.delete(lockPath);
	};
	void result.then(cleanup, cleanup);
	return result;
}

/** Install a pack before its index, which acts as the visibility point. */
export async function installPackPair(
	fs: DurableFileSystem,
	packPath: string,
	packBytes: Uint8Array,
	indexPath: string,
	indexBytes: Uint8Array,
): Promise<void> {
	await createFileDurable(fs, packPath, packBytes);
	await createFileDurable(fs, indexPath, indexBytes);
}

/** Ensure a directory, using durable publication when the filesystem supports it. */
export async function ensureDirectory(fs: FileSystem, path: string): Promise<void> {
	if (isDurable(fs)) {
		await ensureDirectoryDurable(fs, path);
	} else {
		await fs.mkdir(path, { recursive: true });
	}
}

/** Replace a file durably when possible, or write it directly otherwise. */
export async function replaceFile(
	fs: FileSystem,
	path: string,
	content: FileContent,
): Promise<void> {
	if (isDurable(fs)) {
		await replaceFileDurable(fs, path, content);
	} else {
		await ensureDirectory(fs, parentDir(path));
		await fs.writeFile(path, content);
	}
}

/**
 * Create an immutable file, returning whether it was inserted. Plain
 * filesystems retain the prior best-effort exists-then-write behavior.
 */
export async function createFile(
	fs: FileSystem,
	path: string,
	content: FileContent,
): Promise<boolean> {
	if (isDurable(fs)) return createFileDurable(fs, path, content);
	if (await fs.exists(path)) return false;
	await ensureDirectory(fs, parentDir(path));
	await fs.writeFile(path, content);
	return true;
}

/** Remove a file if present, durably when possible. */
export async function removeFile(fs: FileSystem, path: string): Promise<boolean> {
	if (isDurable(fs)) return removeFileDurable(fs, path);
	if (!(await fs.exists(path))) return false;
	await fs.rm(path);
	return true;
}

/** Install a pack/index pair durably when possible. */
export async function installPackPairBestEffort(
	fs: FileSystem,
	packPath: string,
	packBytes: Uint8Array,
	indexPath: string,
	indexBytes: Uint8Array,
): Promise<void> {
	if (isDurable(fs)) {
		await installPackPair(fs, packPath, packBytes, indexPath, indexBytes);
	} else {
		await ensureDirectory(fs, parentDir(packPath));
		await ensureDirectory(fs, parentDir(indexPath));
		await fs.writeFile(packPath, packBytes);
		await fs.writeFile(indexPath, indexBytes);
	}
}

async function withFileLockUnsafe<T>(
	fs: DurableFileSystem,
	lockPath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const parent = parentDir(lockPath);
	await ensureDirectoryDurable(fs, parent);
	const claimant = tempPath(lockPath);
	let acquired = false;

	try {
		await fs.writeFile(claimant, "");
		await fs.fsync(claimant);
		await fs.link(claimant, lockPath);
		acquired = true;
		await fs.fsync(parent);
		return await fn();
	} finally {
		if (acquired) await removeFileDurable(fs, lockPath);
		await fs.rm(claimant, { force: true });
	}
}

function tempPath(path: string): string {
	tempSequence = (tempSequence + 1) >>> 0;
	const nonce = `${Date.now().toString(36)}-${tempSequence.toString(36)}-${Math.random()
		.toString(36)
		.slice(2)}`;
	return `${path}.tmp-${nonce}`;
}

function parentDir(path: string): string {
	const trimmed = trimTrailingSlashes(path);
	const lastSlash = trimmed.lastIndexOf("/");
	if (lastSlash <= 0) return "/";
	return trimmed.slice(0, lastSlash);
}

function trimTrailingSlashes(path: string): string {
	let end = path.length;
	while (end > 1 && path.charCodeAt(end - 1) === 47) end--;
	return path.slice(0, end);
}

async function isDirectory(fs: FileSystem, path: string): Promise<boolean> {
	try {
		return (await fs.stat(path)).isDirectory;
	} catch {
		return false;
	}
}

function isAlreadyExistsError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ("code" in error && (error as { code?: unknown }).code === "EEXIST") return true;
	return "message" in error && /^EEXIST\b/.test(String((error as { message?: unknown }).message));
}
