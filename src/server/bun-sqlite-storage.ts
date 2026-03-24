import type { RawObject, Ref } from "../lib/types.ts";
import type { Storage, RawRefEntry, RefOps } from "./storage.ts";

// ── bun:sqlite types ────────────────────────────────────────────────

/** Minimal prepared statement interface matching `bun:sqlite`. */
interface BunSqliteStatement {
	run(...params: any[]): void;
	get(...params: any[]): any;
	all(...params: any[]): any[];
}

/** Minimal database interface matching `bun:sqlite`'s `Database` class. */
export interface BunSqliteDatabase {
	run(sql: string): void;
	prepare(sql: string): BunSqliteStatement;
	transaction<F extends (...args: any[]) => any>(fn: F): (...args: Parameters<F>) => ReturnType<F>;
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
`;

// ── Prepared statement cache ────────────────────────────────────────

interface Statements {
	repoInsert: BunSqliteStatement;
	repoExists: BunSqliteStatement;
	repoDelete: BunSqliteStatement;

	objInsert: BunSqliteStatement;
	objRead: BunSqliteStatement;
	objExists: BunSqliteStatement;
	objPrefix: BunSqliteStatement;
	objDeleteAll: BunSqliteStatement;
	objListHashes: BunSqliteStatement;
	objDelete: BunSqliteStatement;

	refRead: BunSqliteStatement;
	refWrite: BunSqliteStatement;
	refDelete: BunSqliteStatement;
	refList: BunSqliteStatement;
	refListAll: BunSqliteStatement;
	refDeleteAll: BunSqliteStatement;
}

function prepareStatements(db: BunSqliteDatabase): Statements {
	return {
		repoInsert: db.prepare("INSERT INTO git_repos (id) VALUES (?)"),
		repoExists: db.prepare("SELECT 1 FROM git_repos WHERE id = ? LIMIT 1"),
		repoDelete: db.prepare("DELETE FROM git_repos WHERE id = ?"),

		objInsert: db.prepare(
			"INSERT OR IGNORE INTO git_objects (repo_id, hash, type, content) VALUES (?, ?, ?, ?)",
		),
		objRead: db.prepare("SELECT type, content FROM git_objects WHERE repo_id = ? AND hash = ?"),
		objExists: db.prepare("SELECT 1 FROM git_objects WHERE repo_id = ? AND hash = ? LIMIT 1"),
		objPrefix: db.prepare("SELECT hash FROM git_objects WHERE repo_id = ? AND hash GLOB ?"),
		objDeleteAll: db.prepare("DELETE FROM git_objects WHERE repo_id = ?"),
		objListHashes: db.prepare("SELECT hash FROM git_objects WHERE repo_id = ?"),
		objDelete: db.prepare("DELETE FROM git_objects WHERE repo_id = ? AND hash = ?"),

		refRead: db.prepare("SELECT type, hash, target FROM git_refs WHERE repo_id = ? AND name = ?"),
		refWrite: db.prepare(
			"INSERT OR REPLACE INTO git_refs (repo_id, name, type, hash, target) VALUES (?, ?, ?, ?, ?)",
		),
		refDelete: db.prepare("DELETE FROM git_refs WHERE repo_id = ? AND name = ?"),
		refList: db.prepare(
			"SELECT name, type, hash, target FROM git_refs WHERE repo_id = ? AND name GLOB ?",
		),
		refListAll: db.prepare("SELECT name, type, hash, target FROM git_refs WHERE repo_id = ?"),
		refDeleteAll: db.prepare("DELETE FROM git_refs WHERE repo_id = ?"),
	};
}

// ── BunSqliteStorage ─────────────────────────────────────────────────

/**
 * SQLite-backed storage using `bun:sqlite`.
 *
 * ```ts
 * import { Database } from "bun:sqlite";
 * const storage = createStorageAdapter(new BunSqliteStorage(new Database("repos.db")));
 * ```
 */
export class BunSqliteStorage implements Storage {
	private stmts: Statements;
	private batchInsertTx: (
		rows: ReadonlyArray<{ repoId: string; hash: string; type: string; content: Uint8Array }>,
	) => void;
	private batchDeleteTx: (
		repoId: string,
		hashes: ReadonlyArray<string>,
		onCount: (n: number) => void,
	) => void;

	constructor(private db: BunSqliteDatabase) {
		db.run(SCHEMA);
		this.stmts = prepareStatements(db);
		this.batchInsertTx = db.transaction(
			(
				rows: ReadonlyArray<{
					repoId: string;
					hash: string;
					type: string;
					content: Uint8Array;
				}>,
			) => {
				for (const row of rows) {
					this.stmts.objInsert.run(row.repoId, row.hash, row.type, row.content);
				}
			},
		);
		this.batchDeleteTx = db.transaction(
			(repoId: string, hashes: ReadonlyArray<string>, onCount: (n: number) => void) => {
				let count = 0;
				for (const hash of hashes) {
					this.stmts.objDelete.run(repoId, hash);
					count++;
				}
				onCount(count);
			},
		);
	}

	// ── Repo ────────────────────────────────────────────────────

	hasRepo(repoId: string): boolean {
		return this.stmts.repoExists.get(repoId) !== null;
	}

	insertRepo(repoId: string): void {
		this.stmts.repoInsert.run(repoId);
	}

	deleteRepo(repoId: string): void {
		this.stmts.repoDelete.run(repoId);
		this.stmts.objDeleteAll.run(repoId);
		this.stmts.refDeleteAll.run(repoId);
	}

	// ── Objects ─────────────────────────────────────────────────

	getObject(repoId: string, hash: string): RawObject | null {
		const row = this.stmts.objRead.get(repoId, hash) as {
			type: string;
			content: Uint8Array;
		} | null;
		if (!row) return null;
		return { type: row.type as RawObject["type"], content: new Uint8Array(row.content) };
	}

	putObject(repoId: string, hash: string, type: string, content: Uint8Array): void {
		this.stmts.objInsert.run(repoId, hash, type, content);
	}

	putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): void {
		this.batchInsertTx(objects.map((o) => ({ repoId, ...o })));
	}

	hasObject(repoId: string, hash: string): boolean {
		return this.stmts.objExists.get(repoId, hash) !== null;
	}

	findObjectsByPrefix(repoId: string, prefix: string): string[] {
		const rows = this.stmts.objPrefix.all(repoId, `${prefix}*`) as Array<{ hash: string }>;
		return rows.map((r) => r.hash);
	}

	listObjectHashes(repoId: string): string[] {
		const rows = this.stmts.objListHashes.all(repoId) as Array<{ hash: string }>;
		return rows.map((r) => r.hash);
	}

	deleteObjects(repoId: string, hashes: ReadonlyArray<string>): number {
		if (hashes.length === 0) return 0;
		let deleted = 0;
		this.batchDeleteTx(repoId, hashes, (count) => {
			deleted += count;
		});
		return deleted;
	}

	// ── Refs ────────────────────────────────────────────────────

	getRef(repoId: string, name: string): Ref | null {
		const row = this.stmts.refRead.get(repoId, name) as RefRow | null;
		return rowToRef(row);
	}

	putRef(repoId: string, name: string, ref: Ref): void {
		if (ref.type === "symbolic") {
			this.stmts.refWrite.run(repoId, name, "symbolic", null, ref.target);
		} else {
			this.stmts.refWrite.run(repoId, name, "direct", ref.hash, null);
		}
	}

	removeRef(repoId: string, name: string): void {
		this.stmts.refDelete.run(repoId, name);
	}

	listRefs(repoId: string, prefix?: string): RawRefEntry[] {
		const rows: RefRow[] = prefix
			? (this.stmts.refList.all(repoId, `${prefix}*`) as RefRow[])
			: (this.stmts.refListAll.all(repoId) as RefRow[]);
		return rows.flatMap((row) => {
			const ref = rowToRef(row);
			return ref ? [{ name: row.name, ref }] : [];
		});
	}

	atomicRefUpdate<T>(repoId: string, fn: (ops: RefOps) => T): T {
		const stmts = this.stmts;
		const tx = this.db.transaction(() => {
			return fn({
				getRef: (name) => rowToRef(stmts.refRead.get(repoId, name) as RefRow | null),
				putRef: (name, ref) => {
					if (ref.type === "symbolic") {
						stmts.refWrite.run(repoId, name, "symbolic", null, ref.target);
					} else {
						stmts.refWrite.run(repoId, name, "direct", ref.hash, null);
					}
				},
				removeRef: (name) => {
					stmts.refDelete.run(repoId, name);
				},
			});
		});
		return tx();
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
