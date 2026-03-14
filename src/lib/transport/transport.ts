import type { FetchFunction } from "../../hooks.ts";
import { ZERO_HASH } from "../hex.ts";
import { isAncestor } from "../merge.ts";
import { ingestPackData, readObject } from "../object-db.ts";
import type { PackInput } from "../pack/packfile.ts";
import { writePack } from "../pack/packfile.ts";
import { deleteRef, listRefs, readHead, resolveRef, updateRef } from "../refs.ts";
import type { GitContext, ObjectId } from "../types.ts";
import { enumerateObjects } from "./object-walk.ts";
import {
	discoverRefs,
	fetchPack,
	type HttpAuth,
	type PushCommand,
	pushPack,
} from "./smart-http.ts";

// ── Transport interface ──────────────────────────────────────────────

/** A ref advertised by the remote. */
export interface RemoteRef {
	name: string;
	hash: ObjectId;
	/** For annotated tags: the hash of the object the tag points to. */
	peeledHash?: ObjectId;
}

/** Result of a fetch operation at the transport level. */
export interface FetchResult {
	/** Refs advertised by the remote. */
	remoteRefs: RemoteRef[];
	/** Objects received (already unpacked into the local store). */
	objectCount: number;
}

/** Result of a push operation at the transport level. */
export interface PushResult {
	/** Per-ref update results. */
	updates: PushRefUpdate[];
}

export interface PushRefUpdate {
	name: string;
	oldHash: ObjectId | null;
	newHash: ObjectId;
	ok: boolean;
	error?: string;
}

/**
 * Transport interface: abstracts how objects and refs are exchanged
 * between repositories. Implementations handle local paths, HTTP, etc.
 */
export interface Transport {
	/**
	 * Get the list of refs the remote has.
	 */
	advertiseRefs(): Promise<RemoteRef[]>;

	/**
	 * Fetch objects from the remote that are reachable from `wants`
	 * but not from `haves`. Unpacks received objects into the local store.
	 */
	fetch(wants: ObjectId[], haves: ObjectId[]): Promise<FetchResult>;

	/**
	 * Push objects to the remote. Sends all objects reachable from the
	 * new ref values but not from the old ones, then updates remote refs.
	 */
	push(updates: PushRefUpdate[]): Promise<PushResult>;

	/**
	 * The ref that HEAD points to on the remote (e.g. "refs/heads/main").
	 * Available after advertiseRefs() has been called. Used by clone to
	 * determine the default branch.
	 */
	headTarget?: string;
}

// ── Per-repo push mutex ──────────────────────────────────────────────

class Mutex {
	private queue: Promise<void> = Promise.resolve();

	async acquire(): Promise<() => void> {
		let release!: () => void;
		const next = new Promise<void>((r) => {
			release = r;
		});
		const prev = this.queue;
		this.queue = next;
		await prev;
		return release;
	}
}

const pushLocks = new WeakMap<object, Mutex>();

function getPushLock(fs: object): Mutex {
	let lock = pushLocks.get(fs);
	if (!lock) {
		lock = new Mutex();
		pushLocks.set(fs, lock);
	}
	return lock;
}

// ── Local transport ──────────────────────────────────────────────────

/**
 * Transport implementation for local paths. Both repos live in the
 * same virtual filesystem, so "transfer" means reading objects from
 * one GitContext and writing them to another via packfile serialization.
 */
export class LocalTransport implements Transport {
	headTarget?: string;

	constructor(
		private local: GitContext,
		private remote: GitContext,
	) {}

	async advertiseRefs(): Promise<RemoteRef[]> {
		const refs = await listRefs(this.remote);
		const result: RemoteRef[] = [];
		for (const ref of refs) {
			result.push({ name: ref.name, hash: ref.hash });
		}

		// Also include HEAD if it resolves
		const head = await resolveRef(this.remote, "HEAD");
		if (head) {
			result.push({ name: "HEAD", hash: head });
		}

		// Derive headTarget from the remote's HEAD symref
		const headRef = await readHead(this.remote);
		if (headRef?.type === "symbolic") {
			this.headTarget = headRef.target;
		}

		return result;
	}

	async fetch(wants: ObjectId[], haves: ObjectId[]): Promise<FetchResult> {
		const remoteRefs = await this.advertiseRefs();

		if (wants.length === 0) {
			return { remoteRefs, objectCount: 0 };
		}

		// On the remote side: enumerate objects to send
		const toSend = await enumerateObjects(this.remote, wants, haves);

		if (toSend.length === 0) {
			return { remoteRefs, objectCount: 0 };
		}

		const packInputs: PackInput[] = [];
		for (const obj of toSend) {
			const raw = await readObject(this.remote, obj.hash);
			packInputs.push({ type: raw.type, content: raw.content });
		}
		const packData = await writePack(packInputs);
		const objectCount = await ingestPackData(this.local, packData);

		return { remoteRefs, objectCount };
	}

	async push(updates: PushRefUpdate[]): Promise<PushResult> {
		const release = await getPushLock(this.remote.fs).acquire();
		try {
			return await this.pushInner(updates);
		} finally {
			release();
		}
	}

	private async pushInner(updates: PushRefUpdate[]): Promise<PushResult> {
		const allWants: ObjectId[] = [];
		const allHaves: ObjectId[] = [];

		for (const update of updates) {
			if (update.newHash !== ZERO_HASH) {
				allWants.push(update.newHash);
			}
			if (update.oldHash) {
				allHaves.push(update.oldHash);
			}
		}

		if (allWants.length > 0) {
			const toSend = await enumerateObjects(this.local, allWants, allHaves);

			if (toSend.length > 0) {
				const packInputs: PackInput[] = [];
				for (const obj of toSend) {
					const raw = await readObject(this.local, obj.hash);
					packInputs.push({ type: raw.type, content: raw.content });
				}
				const packData = await writePack(packInputs);
				await ingestPackData(this.remote, packData);
			}
		}

		const results: PushRefUpdate[] = [];
		for (const update of updates) {
			try {
				if (update.newHash === ZERO_HASH) {
					await deleteRef(this.remote, update.name);
					results.push({ ...update, ok: true });
					continue;
				}

				const currentHash = await resolveRef(this.remote, update.name);

				if (currentHash && !update.ok) {
					const ff = await isAncestor(this.remote, currentHash, update.newHash);
					if (!ff) {
						results.push({
							...update,
							ok: false,
							error: `non-fast-forward update rejected for ${update.name}`,
						});
						continue;
					}
				}

				await updateRef(this.remote, update.name, update.newHash);
				results.push({ ...update, ok: true });
			} catch (err) {
				results.push({
					...update,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return { updates: results };
	}
}

// ── Smart HTTP transport ─────────────────────────────────────────────

/**
 * Transport implementation for Git Smart HTTP protocol.
 * Communicates with real Git servers (GitHub, GitLab, etc.) via HTTP(S).
 */
export class SmartHttpTransport implements Transport {
	headTarget?: string;

	private cachedFetchCaps: string[] | null = null;
	private cachedPushCaps: string[] | null = null;
	private cachedFetchRefs: RemoteRef[] | null = null;

	constructor(
		private local: GitContext,
		private url: string,
		private auth?: HttpAuth,
		private fetchFn?: FetchFunction,
	) {}

	async advertiseRefs(): Promise<RemoteRef[]> {
		const result = await discoverRefs(this.url, "git-upload-pack", this.auth, this.fetchFn);
		this.cachedFetchCaps = result.capabilities;
		this.cachedFetchRefs = result.refs;

		const headSymref = result.symrefs.get("HEAD");
		if (headSymref) {
			this.headTarget = headSymref;
		}

		return result.refs;
	}

	private async ensureFetchDiscovery() {
		if (!this.cachedFetchCaps || !this.cachedFetchRefs) {
			await this.advertiseRefs();
		}
		return {
			caps: this.cachedFetchCaps as string[],
			refs: this.cachedFetchRefs as RemoteRef[],
		};
	}

	private async ensurePushDiscovery() {
		if (!this.cachedPushCaps) {
			const result = await discoverRefs(this.url, "git-receive-pack", this.auth, this.fetchFn);
			this.cachedPushCaps = result.capabilities;
		}
		return this.cachedPushCaps as string[];
	}

	async fetch(wants: ObjectId[], haves: ObjectId[]): Promise<FetchResult> {
		const { caps, refs } = await this.ensureFetchDiscovery();

		if (wants.length === 0) {
			return { remoteRefs: refs, objectCount: 0 };
		}

		const result = await fetchPack(this.url, wants, haves, caps, this.auth, this.fetchFn);

		if (result.packData.byteLength === 0) {
			return { remoteRefs: refs, objectCount: 0 };
		}

		const objectCount = await ingestPackData(this.local, result.packData);
		return { remoteRefs: refs, objectCount };
	}

	async push(updates: PushRefUpdate[]): Promise<PushResult> {
		// Client-side fast-forward check (mirrors LocalTransport behaviour).
		// GitHub/GitLab don't reject non-FF pushes on unprotected branches,
		// so the client must enforce this like real git does.
		for (const update of updates) {
			if (
				update.oldHash &&
				update.oldHash !== ZERO_HASH &&
				update.newHash !== ZERO_HASH &&
				!update.ok
			) {
				const ff = await isAncestor(this.local, update.oldHash, update.newHash);
				if (!ff) {
					return {
						updates: updates.map((u) =>
							u === update
								? {
										...u,
										ok: false,
										error: "non-fast-forward",
									}
								: { ...u, ok: false, error: "atomic push failed" },
						),
					};
				}
			}
		}

		const pushCaps = await this.ensurePushDiscovery();

		const commands: PushCommand[] = updates.map((u) => ({
			oldHash: u.oldHash ?? ZERO_HASH,
			newHash: u.newHash,
			refName: u.name,
		}));

		const allWants: ObjectId[] = [];
		const allHaves: ObjectId[] = [];
		let hasNonDelete = false;

		for (const update of updates) {
			if (update.newHash !== ZERO_HASH) {
				allWants.push(update.newHash);
				hasNonDelete = true;
			}
			if (update.oldHash && update.oldHash !== ZERO_HASH) {
				allHaves.push(update.oldHash);
			}
		}

		let packData: Uint8Array | null = null;
		if (hasNonDelete) {
			const toSend = await enumerateObjects(this.local, allWants, allHaves);
			const packInputs: PackInput[] = [];
			for (const obj of toSend) {
				const raw = await readObject(this.local, obj.hash);
				packInputs.push({ type: raw.type, content: raw.content });
			}
			packData = await writePack(packInputs);
		}

		const result = await pushPack(this.url, commands, packData, pushCaps, this.auth, this.fetchFn);

		const resultUpdates: PushRefUpdate[] = updates.map((u) => {
			const refResult = result.refResults.find((r) => r.name === u.name);
			const ok = refResult?.ok ?? result.unpackOk;
			const error =
				refResult?.error ??
				(!ok && result.unpackError ? `unpack failed: ${result.unpackError}` : undefined);
			return { ...u, ok, error };
		});

		return { updates: resultUpdates };
	}
}

export type { HttpAuth } from "./smart-http.ts";
