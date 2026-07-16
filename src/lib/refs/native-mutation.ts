import {
	ensureDirectoryDurable,
	isAlreadyExistsError,
	removeFileDurable,
	replaceFileDurable,
	temporarySiblingPath,
	withPathQueue,
} from "../../fs/durable-io.ts";
import type { DurableFileSystem } from "../../fs/index.ts";
import {
	parseLooseRef,
	refPath,
	removePackedRefFromContent,
	serializeLooseRef,
} from "../file-ref-database.ts";
import { basename, dirname, join, resolve } from "../path.ts";
import type { DirectRef, Ref } from "../types.ts";
import { isPerWorktreeRef } from "./classify.ts";
import { rawRefsEqual } from "./equality.ts";
import { checkRefFormat } from "./name.ts";

const DEFAULT_LOCK_TIMEOUT_MS = 100;
const LOCK_RETRY_DELAY_MS = 5;
const OBJECT_ID = /^[0-9a-f]{40}$/;
const PSEUDO_REF = /^[A-Z][A-Z0-9_]*$/;

export interface NativeRefLayout {
	gitDir: string;
	commonDir: string;
}

export interface NativeRefMutationOptions {
	lockTimeoutMs?: number;
}

export interface NativeRefMutation {
	compareAndSwapRef(name: string, expectedOld: Ref | null, newRef: Ref | null): Promise<boolean>;
	putRef(name: string, ref: Ref): Promise<void>;
	removeRef(name: string): Promise<void>;
}

export interface NativeRefRecoveryOptions {
	includePackedRefsLock?: boolean;
}

export class NativeRefLockContentionError extends Error {
	readonly code = "EEXIST";

	constructor(readonly lockPath: string) {
		super(
			`EEXIST: native ref lock is already present at ${JSON.stringify(lockPath)}; explicit stale-lock recovery is required`,
		);
		this.name = "NativeRefLockContentionError";
	}
}

export interface NativeRefPaths {
	name: string;
	refPath: string;
	lockPath: string;
	packedRefsPath: string;
	packedLockPath: string;
	isPerWorktree: boolean;
}

interface HeldLock {
	lockPath: string;
	claimantPath: string;
	state: "held" | "consumed" | "released";
}

/** Create the Git-compatible durable mutation layer for one native repository layout. */
export function createNativeRefMutation(
	fs: DurableFileSystem,
	layout: NativeRefLayout,
	options: NativeRefMutationOptions = {},
): NativeRefMutation {
	const normalizedLayout = normalizeLayout(layout);
	const lockTimeoutMs = normalizeLockTimeout(options.lockTimeoutMs);

	const pathsFor = (name: string) => nativeRefPaths(normalizedLayout, name);

	return {
		compareAndSwapRef(name, expectedOld, newRef) {
			const paths = pathsFor(name);
			validateOptionalRef(expectedOld, "expected ref");
			validateOptionalRef(newRef, "new ref");
			return withAcquiredLock(fs, paths.lockPath, lockTimeoutMs, async (namedLock) => {
				const current = await readRawRef(fs, paths);
				if (!rawRefsEqual(current, expectedOld)) {
					await releaseLock(fs, namedLock);
					return false;
				}
				if (newRef === null) {
					await deleteWithNamedLock(fs, paths, namedLock, lockTimeoutMs);
				} else {
					await publishRef(fs, namedLock, paths.refPath, newRef);
				}
				return true;
			});
		},

		putRef(name, ref) {
			const paths = pathsFor(name);
			validateRef(ref, "new ref");
			return withAcquiredLock(fs, paths.lockPath, lockTimeoutMs, (namedLock) =>
				publishRef(fs, namedLock, paths.refPath, ref),
			);
		},

		removeRef(name) {
			const paths = pathsFor(name);
			return withAcquiredLock(fs, paths.lockPath, lockTimeoutMs, (namedLock) =>
				deleteWithNamedLock(fs, paths, namedLock, lockTimeoutMs),
			);
		},
	};
}

/** Derive validated canonical paths for a raw ref mutation. */
export function nativeRefPaths(layout: NativeRefLayout, name: string): NativeRefPaths {
	validateRefName(name);
	const normalized = normalizeLayout(layout);
	const perWorktree = isPerWorktreeRef(name);
	const refDir = perWorktree ? normalized.gitDir : normalized.commonDir;
	const path = refPath(refDir, name);
	return {
		name,
		refPath: path,
		lockPath: `${path}.lock`,
		packedRefsPath: join(normalized.commonDir, "packed-refs"),
		packedLockPath: join(normalized.commonDir, "packed-refs.lock"),
		isPerWorktree: perWorktree,
	};
}

/**
 * Explicitly remove one stale native ref lock after the operator has excluded
 * every just-git and native Git ref writer.
 */
export async function recoverNativeRefLock(
	fs: DurableFileSystem,
	layout: NativeRefLayout,
	name: string,
	options: NativeRefRecoveryOptions = {},
): Promise<void> {
	const paths = nativeRefPaths(layout, name);
	await withPathQueue(paths.lockPath, async () => {
		await removeLockAndClaimants(fs, paths.lockPath);
		if (options.includePackedRefsLock) {
			await withPathQueue(paths.packedLockPath, () =>
				removeLockAndClaimants(fs, paths.packedLockPath),
			);
		}
	});
}

async function withAcquiredLock<T>(
	fs: DurableFileSystem,
	lockPath: string,
	timeoutMs: number,
	fn: (lock: HeldLock) => Promise<T>,
): Promise<T> {
	return withPathQueue(lockPath, async () => {
		const lock = await acquireLock(fs, lockPath, timeoutMs);
		try {
			const result = await fn(lock);
			if (lock.state === "held") {
				throw new Error(`native ref lock callback left lock held at ${JSON.stringify(lockPath)}`);
			}
			return result;
		} catch (error) {
			return await rethrowAfterCleanup(error, () => cleanupLock(fs, lock));
		}
	});
}

async function acquireLock(
	fs: DurableFileSystem,
	lockPath: string,
	timeoutMs: number,
): Promise<HeldLock> {
	const parent = dirname(lockPath);
	await ensureDirectoryDurable(fs, parent);
	const deadline = Date.now() + timeoutMs;

	while (true) {
		const claimantPath = temporarySiblingPath(lockPath);
		let linked = false;
		try {
			await fs.writeFile(claimantPath, "");
			await fs.fsync(claimantPath);
			try {
				await fs.link(claimantPath, lockPath);
				linked = true;
			} catch (error) {
				if (!isAlreadyExistsError(error)) throw error;
				await removeFileDurable(fs, claimantPath);
				if (Date.now() >= deadline) throw new NativeRefLockContentionError(lockPath);
				await delay(Math.min(LOCK_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())));
				continue;
			}
			await fs.fsync(parent);
			return { lockPath, claimantPath, state: "held" };
		} catch (error) {
			await rethrowAfterCleanup(error, async () => {
				if (linked) await removeFileDurable(fs, lockPath);
				await removeFileDurable(fs, claimantPath);
			});
		}
	}
}

async function publishRef(
	fs: DurableFileSystem,
	lock: HeldLock,
	path: string,
	ref: Ref,
): Promise<void> {
	await fs.writeFile(lock.lockPath, serializeLooseRef(ref));
	await fs.fsync(lock.lockPath);
	await fs.rename(lock.lockPath, path);
	lock.state = "consumed";
	await fs.fsync(dirname(path));
	await removeFileDurable(fs, lock.claimantPath);
	lock.state = "released";
}

async function deleteWithNamedLock(
	fs: DurableFileSystem,
	paths: NativeRefPaths,
	namedLock: HeldLock,
	timeoutMs: number,
): Promise<void> {
	if (paths.isPerWorktree) {
		await removeFileDurable(fs, paths.refPath);
		await releaseLock(fs, namedLock);
		return;
	}

	await withAcquiredLock(fs, paths.packedLockPath, timeoutMs, async (packedLock) => {
		if (await fs.exists(paths.packedRefsPath)) {
			const content = await fs.readFile(paths.packedRefsPath);
			const removal = removePackedRefFromContent(content, paths.name);
			if (removal.changed) {
				if (removal.content === null) {
					await removeFileDurable(fs, paths.packedRefsPath);
				} else {
					await replaceFileDurable(fs, paths.packedRefsPath, removal.content);
				}
			}
		}

		await removeFileDurable(fs, paths.refPath);
		await releaseLock(fs, packedLock);
	});
	await releaseLock(fs, namedLock);
}

async function readRawRef(fs: DurableFileSystem, paths: NativeRefPaths): Promise<Ref | null> {
	if (await fs.exists(paths.refPath)) {
		const ref = parseLooseRef(await fs.readFile(paths.refPath));
		validateRef(ref, `stored ref ${JSON.stringify(paths.name)}`);
		return ref;
	}
	if (paths.isPerWorktree || !(await fs.exists(paths.packedRefsPath))) return null;

	for (const line of (await fs.readFile(paths.packedRefsPath)).split("\n")) {
		if (!line || line.startsWith("#") || line.startsWith("^")) continue;
		const space = line.indexOf(" ");
		if (space === -1) continue;
		if (line.slice(space + 1).trim() !== paths.name) continue;
		const hash = line.slice(0, space);
		if (!OBJECT_ID.test(hash)) {
			throw new Error(
				`invalid packed object ID for ${JSON.stringify(paths.name)}: ${JSON.stringify(hash)}`,
			);
		}
		return { type: "direct", hash } satisfies DirectRef;
	}
	return null;
}

async function releaseLock(fs: DurableFileSystem, lock: HeldLock): Promise<void> {
	if (lock.state === "released") return;
	if (lock.state === "held") await removeFileDurable(fs, lock.lockPath);
	await removeFileDurable(fs, lock.claimantPath);
	lock.state = "released";
}

async function cleanupLock(fs: DurableFileSystem, lock: HeldLock): Promise<void> {
	if (lock.state === "released") return;
	const errors: unknown[] = [];
	if (lock.state === "held") {
		try {
			await removeFileDurable(fs, lock.lockPath);
		} catch (error) {
			errors.push(error);
		}
	}
	try {
		await removeFileDurable(fs, lock.claimantPath);
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) throw new AggregateError(errors, `failed to clean native lock`);
	lock.state = "released";
}

async function removeLockAndClaimants(fs: DurableFileSystem, lockPath: string): Promise<void> {
	await removeFileDurable(fs, lockPath);
	const parent = dirname(lockPath);
	if (!(await fs.exists(parent))) return;
	const prefix = `${basename(lockPath)}.tmp-`;
	for (const name of await fs.readdir(parent)) {
		if (name.startsWith(prefix)) await removeFileDurable(fs, join(parent, name));
	}
}

async function rethrowAfterCleanup(error: unknown, cleanup: () => Promise<void>): Promise<never> {
	try {
		await cleanup();
	} catch (cleanupError) {
		if (error instanceof Error) {
			Object.defineProperty(error, "cleanupError", {
				value: cleanupError,
				configurable: true,
			});
			throw error;
		}
		throw new AggregateError(
			[error, cleanupError],
			"native ref operation failed and lock cleanup also failed",
		);
	}
	throw error;
}

function normalizeLayout(layout: NativeRefLayout): NativeRefLayout {
	return {
		gitDir: normalizeAbsolutePath(layout.gitDir, "gitDir"),
		commonDir: normalizeAbsolutePath(layout.commonDir, "commonDir"),
	};
}

function normalizeAbsolutePath(path: string, label: string): string {
	const normalized = resolve(path);
	if (!normalized.startsWith("/")) {
		throw new Error(`${label} must be an absolute path: ${JSON.stringify(path)}`);
	}
	return normalized;
}

function normalizeLockTimeout(value: number | undefined): number {
	if (value === undefined) return DEFAULT_LOCK_TIMEOUT_MS;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`lockTimeoutMs must be a finite non-negative number`);
	}
	return value;
}

function validateRefName(name: string): void {
	const valid = name.startsWith("refs/") ? checkRefFormat(name) : PSEUDO_REF.test(name);
	if (!valid) throw new Error(`invalid native ref name: ${JSON.stringify(name)}`);
}

function validateOptionalRef(ref: Ref | null, label: string): void {
	if (ref !== null) validateRef(ref, label);
}

function validateRef(ref: Ref, label: string): void {
	if (ref.type === "direct") {
		if (!OBJECT_ID.test(ref.hash)) {
			throw new Error(`${label} has an invalid SHA-1 object ID: ${JSON.stringify(ref.hash)}`);
		}
		return;
	}
	if (!ref.target.startsWith("refs/") || !checkRefFormat(ref.target)) {
		throw new Error(`${label} has an invalid symbolic target: ${JSON.stringify(ref.target)}`);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
