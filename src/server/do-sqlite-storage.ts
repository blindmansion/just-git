import type { RawObject, Ref } from "../lib/types.ts";
import type { Storage, RawRefEntry, RefOps } from "./storage.ts";

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
  repo_id TEXT NOT NULL,
  hash    TEXT NOT NULL,
  type    TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (repo_id, hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS git_refs (
  repo_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  type    TEXT NOT NULL CHECK(type IN ('direct', 'symbolic')),
  hash    TEXT,
  target  TEXT,
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

	objInsert: "INSERT OR IGNORE INTO git_objects (repo_id, hash, type, content) VALUES (?, ?, ?, ?)",
	objRead: "SELECT type, content FROM git_objects WHERE repo_id = ? AND hash = ?",
	objExists: "SELECT 1 FROM git_objects WHERE repo_id = ? AND hash = ? LIMIT 1",
	objPrefix: "SELECT hash FROM git_objects WHERE repo_id = ? AND hash GLOB ?",
	objDeleteAll: "DELETE FROM git_objects WHERE repo_id = ?",
	objListHashes: "SELECT hash FROM git_objects WHERE repo_id = ?",
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
export class DurableObjectSqliteStorage implements Storage {
	private sql: DOSqlApi;

	constructor(private storage: DurableObjectStorageSql) {
		this.sql = storage.sql;
		this.sql.exec(SCHEMA);
	}

	// ── Repo ────────────────────────────────────────────────────

	hasRepo(repoId: string): boolean {
		return first(this.sql.exec(SQL.repoExists, repoId)) !== null;
	}

	insertRepo(repoId: string): void {
		this.sql.exec(SQL.repoInsert, repoId);
	}

	deleteRepo(repoId: string): void {
		this.sql.exec(SQL.repoDelete, repoId);
		this.sql.exec(SQL.objDeleteAll, repoId);
		this.sql.exec(SQL.refDeleteAll, repoId);
		this.sql.exec(SQL.forkDelete, repoId);
	}

	// ── Objects ─────────────────────────────────────────────────

	getObject(repoId: string, hash: string): RawObject | null {
		const row = first(this.sql.exec(SQL.objRead, repoId, hash));
		if (!row) return null;
		return { type: row.type as RawObject["type"], content: new Uint8Array(row.content) };
	}

	getObjects(repoId: string, hashes: ReadonlyArray<string>): Map<string, RawObject> {
		const uniqueHashes = Array.from(new Set(hashes));
		if (uniqueHashes.length === 0) return new Map();
		if (uniqueHashes.length === 1) {
			const obj = this.getObject(repoId, uniqueHashes[0]!);
			return obj ? new Map([[uniqueHashes[0]!, obj]]) : new Map();
		}
		const rows = this.sql
			.exec(
				`SELECT hash, type, content FROM git_objects WHERE repo_id = ? AND hash IN (${placeholders(uniqueHashes.length)})`,
				repoId,
				...uniqueHashes,
			)
			.toArray() as Array<{ hash: string; type: string; content: Uint8Array }>;
		const result = new Map<string, RawObject>();
		for (const row of rows) {
			result.set(row.hash, {
				type: row.type as RawObject["type"],
				content: new Uint8Array(row.content),
			});
		}
		return result;
	}

	putObject(repoId: string, hash: string, type: string, content: Uint8Array): void {
		this.sql.exec(SQL.objInsert, repoId, hash, type, content);
	}

	putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): string[] {
		const inserted: string[] = [];
		this.storage.transactionSync(() => {
			for (const obj of objects) {
				if (first(this.sql.exec(SQL.objExists, repoId, obj.hash)) !== null) continue;
				this.sql.exec(SQL.objInsert, repoId, obj.hash, obj.type, obj.content);
				inserted.push(obj.hash);
			}
		});
		return inserted;
	}

	hasObject(repoId: string, hash: string): boolean {
		return first(this.sql.exec(SQL.objExists, repoId, hash)) !== null;
	}

	hasObjects(repoId: string, hashes: ReadonlyArray<string>): Set<string> {
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

	findObjectsByPrefix(repoId: string, prefix: string): string[] {
		return this.sql
			.exec(SQL.objPrefix, repoId, `${prefix}*`)
			.toArray()
			.map((r) => r.hash);
	}

	listObjectHashes(repoId: string): string[] {
		return this.sql
			.exec(SQL.objListHashes, repoId)
			.toArray()
			.map((r) => r.hash);
	}

	deleteObjects(repoId: string, hashes: ReadonlyArray<string>): number {
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

	getRef(repoId: string, name: string): Ref | null {
		return rowToRef(first(this.sql.exec(SQL.refRead, repoId, name)));
	}

	putRef(repoId: string, name: string, ref: Ref): void {
		if (ref.type === "symbolic") {
			this.sql.exec(SQL.refWrite, repoId, name, "symbolic", null, ref.target);
		} else {
			this.sql.exec(SQL.refWrite, repoId, name, "direct", ref.hash, null);
		}
	}

	removeRef(repoId: string, name: string): void {
		this.sql.exec(SQL.refDelete, repoId, name);
	}

	listRefs(repoId: string, prefix?: string): RawRefEntry[] {
		const rows: RefRow[] = prefix
			? this.sql.exec(SQL.refList, repoId, `${prefix}*`).toArray()
			: this.sql.exec(SQL.refListAll, repoId).toArray();
		return rows.flatMap((row) => {
			const ref = rowToRef(row);
			return ref ? [{ name: row.name, ref }] : [];
		});
	}

	atomicRefUpdate<T>(repoId: string, fn: (ops: RefOps) => T): T {
		return this.storage.transactionSync(() => {
			return fn({
				getRef: (name) => rowToRef(first(this.sql.exec(SQL.refRead, repoId, name))),
				putRef: (name, ref) => {
					if (ref.type === "symbolic") {
						this.sql.exec(SQL.refWrite, repoId, name, "symbolic", null, ref.target);
					} else {
						this.sql.exec(SQL.refWrite, repoId, name, "direct", ref.hash, null);
					}
				},
				removeRef: (name) => {
					this.sql.exec(SQL.refDelete, repoId, name);
				},
			});
		});
	}

	// ── Forks ───────────────────────────────────────────────────

	forkRepo(sourceId: string, targetId: string): void {
		this.sql.exec(SQL.forkInsert, targetId, sourceId);
	}

	getForkParent(repoId: string): string | null {
		const row = first(this.sql.exec(SQL.forkGetParent, repoId));
		return row?.parent_id ?? null;
	}

	listForks(repoId: string): string[] {
		return this.sql
			.exec(SQL.forkListChildren, repoId)
			.toArray()
			.map((r) => r.repo_id);
	}
}

// ── Shared helpers ──────────────────────────────────────────────────

type RefRow = { name: string; type: string; hash: string | null; target: string | null };

function rowToRef(row: RefRow | null): Ref | null {
	if (!row) return null;
	if (row.type === "symbolic" && row.target) {
		return { type: "symbolic", target: row.target };
	}
	if (row.type === "direct" && row.hash) {
		return { type: "direct", hash: row.hash };
	}
	return null;
}

function placeholders(count: number): string {
	return Array(count).fill("?").join(", ");
}
