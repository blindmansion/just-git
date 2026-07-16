import { ensureDirectoryDurable, removeFileDurable, replaceFileDurable } from "../fs/durable-io.ts";
import type { DurableFileSystem } from "../fs/index.ts";
import { configBool, parseConfig, serializeConfig } from "../lib/config/parse.ts";
import { parseLooseRef, serializeLooseRef } from "../lib/file-ref-database.ts";
import { dirname, join, resolve } from "../lib/path.ts";
import {
	type NativeRefRecoveryOptions,
	recoverNativeRefLock,
} from "../lib/refs/native-mutation.ts";
import { checkRefFormat } from "../lib/refs/name.ts";
import type { Ref } from "../lib/types.ts";
import { FsObjectStorage } from "./fs-object-storage.ts";
import { FsRefStorage } from "./fs-ref-storage.ts";
import type { RepoStorage } from "./repo-storage.ts";
import type { DeltaObjectRow, RawRefEntry, StoredObject } from "./repo-store.ts";

const OBJECT_ID = /^[0-9a-f]{40}$/;
const LEGACY_REF_LOCK = ".just-git-ref.lock";

export type RecoverFsRepoStorageOptions = NativeRefRecoveryOptions;

/**
 * Open or create native-layout storage for one bare repository.
 *
 * Existing directories must already be complete bare repositories and are
 * never repaired or rewritten. A missing directory is initialized with a
 * durable empty layout whose HEAD points at refs/heads/main.
 */
export async function createFsRepoStorage(
	fs: DurableFileSystem,
	repoDir: string,
): Promise<RepoStorage> {
	const root = requireAbsoluteNormalizedPath(repoDir);
	await cleanupBareRepoStages(fs, root);
	if (await fs.exists(root)) {
		await validateBareRepoLayout(fs, root);
	} else {
		await createBareRepoLayout(fs, root);
	}

	return new FsRepoStorage(new FsObjectStorage(fs, root), new FsRefStorage(fs, root));
}

/**
 * Explicitly recover a repository after the operator has excluded all ref
 * operations, including acquisitions that have not published their lock yet.
 */
export async function recoverFsRepoStorage(
	fs: DurableFileSystem,
	repoDir: string,
	refName: string,
	options: RecoverFsRepoStorageOptions = {},
): Promise<RepoStorage> {
	const root = requireAbsoluteNormalizedPath(repoDir);
	await validateBareRepoLayout(fs, root);
	await recoverNativeRefLock(
		fs,
		{ gitDir: root, commonDir: root },
		refName,
		options,
	);
	const lockPath = join(root, LEGACY_REF_LOCK);
	if (await fs.exists(lockPath)) await removeFileDurable(fs, lockPath);
	await cleanupRefLockClaimants(fs, root);
	return createFsRepoStorage(fs, root);
}

class FsRepoStorage implements RepoStorage {
	constructor(
		private objects: FsObjectStorage,
		private refs: FsRefStorage,
	) {}

	getObject(hash: string): Promise<StoredObject | null> {
		return this.objects.getObject(hash);
	}

	getObjects(hashes: ReadonlyArray<string>): Promise<Map<string, StoredObject>> {
		return this.objects.getObjects(hashes);
	}

	putObject(hash: string, type: string, content: Uint8Array): Promise<void> {
		return this.objects.putObject(hash, type, content);
	}

	putObjects(
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): Promise<string[]> {
		return this.objects.putObjects(objects);
	}

	putDeltaObjects(rows: ReadonlyArray<DeltaObjectRow>): Promise<void> {
		return this.objects.putDeltaObjects(rows);
	}

	hasObject(hash: string): Promise<boolean> {
		return this.objects.hasObject(hash);
	}

	hasObjects(hashes: ReadonlyArray<string>): Promise<Set<string>> {
		return this.objects.hasObjects(hashes);
	}

	findObjectsByPrefix(prefix: string): Promise<string[]> {
		return this.objects.findObjectsByPrefix(prefix);
	}

	listObjectHashes(): Promise<string[]> {
		return this.objects.listObjectHashes();
	}

	repoByteSize(): Promise<number> {
		return this.objects.repoByteSize();
	}

	deleteObjects(hashes: ReadonlyArray<string>): Promise<number> {
		return this.objects.deleteObjects(hashes);
	}

	getRef(name: string): Promise<Ref | null> {
		return this.refs.getRef(name);
	}

	putRef(name: string, ref: Ref): Promise<void> {
		return this.refs.putRef(name, ref);
	}

	removeRef(name: string): Promise<void> {
		return this.refs.removeRef(name);
	}

	listRefs(prefix?: string): Promise<RawRefEntry[]> {
		return this.refs.listRefs(prefix);
	}

	compareAndSwapRef(
		name: string,
		expectedOld: Ref | null,
		newRef: Ref | null,
	): Promise<boolean> {
		return this.refs.compareAndSwapRef(name, expectedOld, newRef);
	}
}

/**
 * Initialize a missing directory through a complete sibling stage, then
 * atomically publish it at the requested path.
 */
export async function createBareRepoLayout(fs: DurableFileSystem, repoDir: string): Promise<void> {
	const parent = dirname(repoDir);
	await ensureDirectoryDurable(fs, parent);
	await cleanupBareRepoStages(fs, repoDir);
	if (await fs.exists(repoDir)) {
		throw new Error(`repository path already exists: ${JSON.stringify(repoDir)}`);
	}

	const stagePath = join(parent, `${bareRepoStagePrefix(repoDir)}${nonce()}`);
	let published = false;
	try {
		await createBareRepoLayoutInPlace(fs, stagePath);
		await fs.fsync(stagePath);
		await fs.rename(stagePath, repoDir);
		published = true;
		await fs.fsync(parent);
	} finally {
		if (!published) {
			await fs.rm(stagePath, { recursive: true, force: true });
			await fs.fsync(parent);
		}
	}
}

/** Construct a complete durable bare layout at an unpublished staging path. */
export async function createBareRepoLayoutInPlace(
	fs: DurableFileSystem,
	repoDir: string,
): Promise<void> {
	const parent = dirname(repoDir);
	await fs.mkdir(repoDir);
	await fs.fsync(parent);

	let complete = false;
	try {
		await ensureDirectoryDurable(fs, join(repoDir, "objects"));
		await ensureDirectoryDurable(fs, join(repoDir, "refs", "heads"));
		await ensureDirectoryDurable(fs, join(repoDir, "refs", "tags"));
		await replaceFileDurable(
			fs,
			join(repoDir, "config"),
			serializeConfig({
				core: {
					repositoryformatversion: "0",
					filemode: "true",
					bare: "true",
				},
			}),
		);
		// HEAD is the visibility point: all other required entries are durable
		// before the directory can be recognized as a repository.
		await replaceFileDurable(
			fs,
			join(repoDir, "HEAD"),
			serializeLooseRef({ type: "symbolic", target: "refs/heads/main" }),
		);
		complete = true;
	} finally {
		if (!complete) {
			await fs.rm(repoDir, { recursive: true, force: true });
			await fs.fsync(parent);
		}
	}
}

async function cleanupBareRepoStages(fs: DurableFileSystem, repoDir: string): Promise<void> {
	const parent = dirname(repoDir);
	if (!(await fs.exists(parent))) return;
	const prefix = bareRepoStagePrefix(repoDir);
	for (const name of await fs.readdir(parent)) {
		if (!name.startsWith(prefix) || !/^[a-z0-9-]+$/.test(name.slice(prefix.length))) continue;
		await fs.rm(join(parent, name), { recursive: true });
		await fs.fsync(parent);
	}
}

async function cleanupRefLockClaimants(fs: DurableFileSystem, repoDir: string): Promise<void> {
	const prefix = `${LEGACY_REF_LOCK}.tmp-`;
	for (const name of await fs.readdir(repoDir)) {
		if (!name.startsWith(prefix)) continue;
		await fs.rm(join(repoDir, name), { force: true });
		await fs.fsync(repoDir);
	}
}

function bareRepoStagePrefix(repoDir: string): string {
	return `.stage-${basename(repoDir)}-`;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function nonce(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Validate the native bare-repository shape supported by filesystem storage. */
export async function validateBareRepoLayout(
	fs: DurableFileSystem,
	repoDir: string,
): Promise<void> {
	await requireEntryType(fs, join(repoDir, "HEAD"), "file");
	await requireEntryType(fs, join(repoDir, "config"), "file");
	await requireEntryType(fs, join(repoDir, "objects"), "directory");
	await requireEntryType(fs, join(repoDir, "refs"), "directory");

	const head = parseLooseRef(await fs.readFile(join(repoDir, "HEAD")));
	if (
		(head.type === "direct" && !OBJECT_ID.test(head.hash)) ||
		(head.type === "symbolic" && (!head.target.startsWith("refs/") || !checkRefFormat(head.target)))
	) {
		throw new Error(`invalid bare repository HEAD at ${JSON.stringify(repoDir)}`);
	}

	const config = parseConfig(await fs.readFile(join(repoDir, "config")));
	if (configBool(config.core?.bare) !== true) {
		throw new Error(`repository is not configured as bare: ${JSON.stringify(repoDir)}`);
	}
	const formatVersion = config.core?.repositoryformatversion ?? "0";
	const objectFormat = config.extensions?.objectformat ?? "sha1";
	const refStorage = config.extensions?.refstorage ?? "files";
	if (formatVersion !== "0" || objectFormat !== "sha1" || refStorage !== "files") {
		throw new Error(`unsupported bare repository format at ${JSON.stringify(repoDir)}`);
	}
}

async function requireEntryType(
	fs: DurableFileSystem,
	path: string,
	expected: "file" | "directory",
): Promise<void> {
	let stat;
	try {
		stat = await fs.stat(path);
	} catch {
		throw new Error(`bare repository is missing required ${expected}: ${JSON.stringify(path)}`);
	}
	const valid = expected === "file" ? stat.isFile : stat.isDirectory;
	if (!valid) {
		throw new Error(`bare repository entry is not a ${expected}: ${JSON.stringify(path)}`);
	}
}

/** Require an absolute normalized POSIX filesystem path. */
export function requireAbsoluteNormalizedPath(path: string): string {
	const normalized = resolve(path);
	const withoutTrailingSlashes = path.length > 1 ? path.replace(/\/+$/, "") : path;
	if (!path.startsWith("/") || path.includes("\0") || normalized !== withoutTrailingSlashes) {
		throw new Error(`repository path must be absolute and normalized: ${JSON.stringify(path)}`);
	}
	return normalized;
}
