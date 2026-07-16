import type { Ref } from "../lib/types.ts";
import type { DeltaObjectRow, ObjectRow, RawRefEntry, RefRow, StoredObject } from "./repo-store.ts";
import type { RepoPool } from "./repo-pool.ts";
import { compareAndSwapRawRef, type RepoStorage } from "./repo-storage.ts";

// ── Durable Object SQLite types ─────────────────────────────────────

/** Minimal cursor interface matching Cloudflare's `SqlStorageCursor`. */
interface DOSqlCursor {
	next(): { done?: false; value: any } | { done: true; value?: undefined };
	toArray(): any[];
}

/** Minimal interface matching the `SqlStorage` property of `DurableObjectStorage`. */
interface DOSqlApi {
	exec(query: string, ...bindings: any[]): DOSqlCursor;
}

/**
 * Minimal interface matching Cloudflare's `DurableObjectStorage` for
 * SQLite-backed Durable Objects.
 *
 * Only the `sql` and `transactionSync` properties are required.
 * Pass `ctx.storage` from your Durable Object constructor.
 */
export interface DurableObjectStorageSql {
	sql: DOSqlApi;
	transactionSync<T>(closure: () => T): T;
}

// ── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS git_repos (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS git_objects (
  repo_id   TEXT NOT NULL,
  hash      TEXT NOT NULL,
  type      TEXT NOT NULL,
  content   BLOB NOT NULL,
  encoding  TEXT NOT NULL DEFAULT 'raw',
  base_hash TEXT,
  PRIMARY KEY (repo_id, hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS git_refs (
  repo_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  type    TEXT NOT NULL CHECK(type IN ('direct', 'symbolic')),
  hash    TEXT,
  target  TEXT,
  CHECK (
    (type = 'direct' AND hash IS NOT NULL AND target IS NULL) OR
    (type = 'symbolic' AND hash IS NULL AND target IS NOT NULL)
  ),
  PRIMARY KEY (repo_id, name)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS git_forks (
  repo_id   TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL
);
`;

// ── SQL queries ─────────────────────────────────────────────────────

const SQL = {
	repoInsert: "INSERT INTO git_repos (id) VALUES (?)",
	repoExists: "SELECT 1 FROM git_repos WHERE id = ? LIMIT 1",
	repoDelete: "DELETE FROM git_repos WHERE id = ?",

	objInsert:
		"INSERT OR IGNORE INTO git_objects (repo_id, hash, type, content) VALUES (?, ?, ?, ?) RETURNING hash",
	objReplace:
		"INSERT OR REPLACE INTO git_objects (repo_id, hash, type, content, encoding, base_hash) VALUES (?, ?, ?, ?, ?, ?)",
	objRead:
		"SELECT type, content, encoding, base_hash FROM git_objects WHERE repo_id = ? AND hash = ?",
	objExists: "SELECT 1 FROM git_objects WHERE repo_id = ? AND hash = ? LIMIT 1",
	objPrefix: "SELECT hash FROM git_objects WHERE repo_id = ? AND hash GLOB ?",
	objDeleteAll: "DELETE FROM git_objects WHERE repo_id = ?",
	objListHashes: "SELECT hash FROM git_objects WHERE repo_id = ?",
	objByteSize:
		"SELECT COALESCE(SUM(LENGTH(content)), 0) AS size FROM git_objects WHERE repo_id = ?",
	objDelete: "DELETE FROM git_objects WHERE repo_id = ? AND hash = ?",

	refRead: "SELECT type, hash, target FROM git_refs WHERE repo_id = ? AND name = ?",
	refWrite:
		"INSERT OR REPLACE INTO git_refs (repo_id, name, type, hash, target) VALUES (?, ?, ?, ?, ?)",
	refDelete: "DELETE FROM git_refs WHERE repo_id = ? AND name = ?",
	refList: "SELECT name, type, hash, target FROM git_refs WHERE repo_id = ? AND name GLOB ?",
	refListAll: "SELECT name, type, hash, target FROM git_refs WHERE repo_id = ?",
	refDeleteAll: "DELETE FROM git_refs WHERE repo_id = ?",

	forkInsert: "INSERT INTO git_forks (repo_id, parent_id) VALUES (?, ?)",
	forkGetParent: "SELECT parent_id FROM git_forks WHERE repo_id = ?",
	forkListChildren: "SELECT repo_id FROM git_forks WHERE parent_id = ?",
	forkDelete: "DELETE FROM git_forks WHERE repo_id = ?",
} as const;

// ── Helpers ─────────────────────────────────────────────────────────

function first(cursor: DOSqlCursor): any {
	const r = cursor.next();
	return r.done ? null : r.value;
}

// ── DurableObjectSqliteStorage ──────────────────────────────────────

/**
 * SQLite-backed storage for Cloudflare Durable Objects.
 *
 * Uses the DO SQLite API (`ctx.storage.sql`) for queries and
 * `ctx.storage.transactionSync()` for atomic ref updates.
 *
 * ```ts
 * import { DurableObject } from "cloudflare:workers";
 *
 * export class GitRepoDO extends DurableObject {
 *   private storage;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.storage = new DurableObjectSqliteStorage(ctx.storage);
 *   }
 * }
 * ```
 */
export class DurableObjectSqliteStorage implements RepoPool {
	private sql: DOSqlApi;

	constructor(private storage: DurableObjectStorageSql) {
		this.sql = storage.sql;
		this.sql.exec(SCHEMA);
	}

	// ── Repo ────────────────────────────────────────────────────

	hasRepo(repoId: string): boolean {
		return first(this.sql.exec(SQL.repoExists, repoId)) !== null;
	}

	createRepo(repoId: string): void {
		this.sql.exec(SQL.repoInsert, repoId);
	}

	deleteRepo(repoId: string): void {
		this.sql.exec(SQL.repoDelete, repoId);
		this.sql.exec(SQL.objDeleteAll, repoId);
		this.sql.exec(SQL.refDeleteAll, repoId);
		this.sql.exec(SQL.forkDelete, repoId);
	}

	open(repoId: string): RepoStorage {
		return {
			getObject: (hash) => this.getObject(repoId, hash),
			getObjects: (hashes) => this.getObjects(repoId, hashes),
			putObject: (hash, type, content) => this.putObject(repoId, hash, type, content),
			putObjects: (objects) => this.putObjects(repoId, objects),
			putDeltaObjects: (rows) => this.putDeltaObjects(repoId, rows),
			hasObject: (hash) => this.hasObject(repoId, hash),
			hasObjects: (hashes) => this.hasObjects(repoId, hashes),
			findObjectsByPrefix: (prefix) => this.findObjectsByPrefix(repoId, prefix),
			listObjectHashes: () => this.listObjectHashes(repoId),
			repoByteSize: () => this.repoByteSize(repoId),
			deleteObjects: (hashes) => this.deleteObjects(repoId, hashes),
			getRef: (name) => this.getRef(repoId, name),
			putRef: (name, ref) => this.putRef(repoId, name, ref),
			removeRef: (name) => this.removeRef(repoId, name),
			listRefs: (prefix) => this.listRefs(repoId, prefix),
			compareAndSwapRef: (name, expectedOld, newRef) =>
				this.compareAndSwapRef(repoId, name, expectedOld, newRef),
		};
	}

	// ── Objects ─────────────────────────────────────────────────

	private getObject(repoId: string, hash: string): StoredObject | null {
		return rowToStored(first(this.sql.exec(SQL.objRead, repoId, hash)));
	}

	private getObjects(repoId: string, hashes: ReadonlyArray<string>): Map<string, StoredObject> {
		const uniqueHashes = Array.from(new Set(hashes));
		if (uniqueHashes.length === 0) return new Map();
		if (uniqueHashes.length === 1) {
			const obj = this.getObject(repoId, uniqueHashes[0]!);
			return obj ? new Map([[uniqueHashes[0]!, obj]]) : new Map();
		}
		const rows = this.sql
			.exec(
				`SELECT hash, type, content, encoding, base_hash FROM git_objects WHERE repo_id = ? AND hash IN (${placeholders(uniqueHashes.length)})`,
				repoId,
				...uniqueHashes,
			)
			.toArray() as ObjectRow[];
		const result = new Map<string, StoredObject>();
		for (const row of rows) {
			const stored = rowToStored(row);
			if (stored) result.set(row.hash!, stored);
		}
		return result;
	}

	private putObject(repoId: string, hash: string, type: string, content: Uint8Array): void {
		this.sql.exec(SQL.objInsert, repoId, hash, type, content);
	}

	private putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): string[] {
		const inserted: string[] = [];
		this.storage.transactionSync(() => {
			for (const obj of objects) {
				const row = first(this.sql.exec(SQL.objInsert, repoId, obj.hash, obj.type, obj.content));
				if (row) inserted.push(row.hash);
			}
		});
		return inserted;
	}

	private putDeltaObjects(repoId: string, rows: ReadonlyArray<DeltaObjectRow>): void {
		if (rows.length === 0) return;
		this.storage.transactionSync(() => {
			for (const row of rows) {
				const baseHash = "baseHash" in row ? row.baseHash : null;
				this.sql.exec(
					SQL.objReplace,
					repoId,
					row.hash,
					row.type,
					row.content,
					row.encoding,
					baseHash,
				);
			}
		});
	}

	private hasObject(repoId: string, hash: string): boolean {
		return first(this.sql.exec(SQL.objExists, repoId, hash)) !== null;
	}

	private hasObjects(repoId: string, hashes: ReadonlyArray<string>): Set<string> {
		const uniqueHashes = Array.from(new Set(hashes));
		if (uniqueHashes.length === 0) return new Set();
		if (uniqueHashes.length === 1) {
			return this.hasObject(repoId, uniqueHashes[0]!) ? new Set(uniqueHashes) : new Set();
		}
		const rows = this.sql
			.exec(
				`SELECT hash FROM git_objects WHERE repo_id = ? AND hash IN (${placeholders(uniqueHashes.length)})`,
				repoId,
				...uniqueHashes,
			)
			.toArray() as Array<{ hash: string }>;
		return new Set(rows.map((row) => row.hash));
	}

	private findObjectsByPrefix(repoId: string, prefix: string): string[] {
		return this.sql
			.exec(SQL.objPrefix, repoId, `${prefix}*`)
			.toArray()
			.map((r) => r.hash);
	}

	private listObjectHashes(repoId: string): string[] {
		return this.sql
			.exec(SQL.objListHashes, repoId)
			.toArray()
			.map((r) => r.hash);
	}

	private repoByteSize(repoId: string): number {
		const row = first(this.sql.exec(SQL.objByteSize, repoId));
		return row ? Number(row.size) : 0;
	}

	private deleteObjects(repoId: string, hashes: ReadonlyArray<string>): number {
		if (hashes.length === 0) return 0;
		const uniqueHashes = Array.from(new Set(hashes));
		const existing = this.hasObjects(repoId, uniqueHashes);
		if (existing.size === 0) return 0;
		let deleted = 0;
		this.storage.transactionSync(() => {
			for (const hash of existing) {
				this.sql.exec(SQL.objDelete, repoId, hash);
				deleted++;
			}
		});
		return deleted;
	}

	// ── Refs ────────────────────────────────────────────────────

	private getRef(repoId: string, name: string): Ref | null {
		return rowToRef(first(this.sql.exec(SQL.refRead, repoId, name)));
	}

	private putRef(repoId: string, name: string, ref: Ref): void {
		if (ref.type === "symbolic") {
			this.sql.exec(SQL.refWrite, repoId, name, "symbolic", null, ref.target);
		} else {
			this.sql.exec(SQL.refWrite, repoId, name, "direct", ref.hash, null);
		}
	}

	private removeRef(repoId: string, name: string): void {
		this.sql.exec(SQL.refDelete, repoId, name);
	}

	private listRefs(repoId: string, prefix?: string): RawRefEntry[] {
		const rows: RefRow[] = prefix
			? this.sql.exec(SQL.refList, repoId, `${prefix}*`).toArray()
			: this.sql.exec(SQL.refListAll, repoId).toArray();
		return rows.flatMap((row) => {
			const ref = rowToRef(row);
			return ref ? [{ name: row.name, ref }] : [];
		});
	}

	private compareAndSwapRef(
		repoId: string,
		name: string,
		expectedOld: Ref | null,
		newRef: Ref | null,
	): boolean {
		return this.storage.transactionSync(() => {
			return compareAndSwapRawRef(
				() => this.getRef(repoId, name),
				(ref) => this.putRef(repoId, name, ref),
				() => this.removeRef(repoId, name),
				expectedOld,
				newRef,
			);
		});
	}

	// ── Forks ───────────────────────────────────────────────────

	fork(sourceId: string, targetId: string): void {
		this.sql.exec(SQL.forkInsert, targetId, sourceId);
	}

	parentOf(repoId: string): string | null {
		const row = first(this.sql.exec(SQL.forkGetParent, repoId));
		return row?.parent_id ?? null;
	}

	forksOf(repoId: string): string[] {
		return this.sql
			.exec(SQL.forkListChildren, repoId)
			.toArray()
			.map((r) => r.repo_id);
	}
}

// ── Shared helpers ──────────────────────────────────────────────────

function rowToStored(row: ObjectRow | null): StoredObject | null {
	if (!row) return null;
	return {
		type: row.type as StoredObject["type"],
		encoding: row.encoding as StoredObject["encoding"],
		baseHash: row.base_hash,
		content: new Uint8Array(row.content),
	};
}

function rowToRef(row: RefRow | null): Ref | null {
	if (!row) return null;
	if (row.type === "symbolic" && row.target !== null && row.hash === null) {
		return { type: "symbolic", target: row.target };
	}
	if (row.type === "direct" && row.hash !== null && row.target === null) {
		return { type: "direct", hash: row.hash };
	}
	throw new Error("corrupt ref row: invalid type/hash/target combination");
}

function placeholders(count: number): string {
	return Array(count).fill("?").join(", ");
}
