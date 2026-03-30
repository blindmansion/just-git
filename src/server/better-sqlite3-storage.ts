import type { RawObject, Ref } from "../lib/types.ts";
import type { Storage, RawRefEntry, RefOps } from "./storage.ts";

// ── better-sqlite3 types ────────────────────────────────────────────

/** Minimal prepared statement interface matching `better-sqlite3`. */
interface BetterSqlite3Statement {
	run(...params: any[]): any;
	get(...params: any[]): any;
	all(...params: any[]): any[];
}

/** Minimal database interface matching the `better-sqlite3` `Database` class. */
export interface BetterSqlite3Database {
	exec(sql: string): any;
	prepare(sql: string): BetterSqlite3Statement;
	transaction(fn: (...args: any[]) => any): (...args: any[]) => any;
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

// ── Normalized statement interface ──────────────────────────────────
// better-sqlite3's .get() returns undefined for no match; we normalize
// to null at preparation time so the driver code can stay uniform.

interface Statement {
	run(...params: any[]): void;
	get(...params: any[]): any;
	all(...params: any[]): any[];
}

function wrapStmt(raw: BetterSqlite3Statement): Statement {
	return {
		run: (...args) => {
			raw.run(...args);
		},
		get: (...args) => raw.get(...args) ?? null,
		all: (...args) => raw.all(...args),
	};
}

// ── Prepared statement cache ────────────────────────────────────────

interface Statements {
	repoInsert: Statement;
	repoExists: Statement;
	repoDelete: Statement;

	objInsert: Statement;
	objRead: Statement;
	objExists: Statement;
	objPrefix: Statement;
	objDeleteAll: Statement;
	objListHashes: Statement;
	objDelete: Statement;

	refRead: Statement;
	refWrite: Statement;
	refDelete: Statement;
	refList: Statement;
	refListAll: Statement;
	refDeleteAll: Statement;

	forkInsert: Statement;
	forkGetParent: Statement;
	forkListChildren: Statement;
	forkDelete: Statement;
}

function prepareStatements(db: BetterSqlite3Database): Statements {
	return {
		repoInsert: wrapStmt(db.prepare("INSERT INTO git_repos (id) VALUES (?)")),
		repoExists: wrapStmt(db.prepare("SELECT 1 FROM git_repos WHERE id = ? LIMIT 1")),
		repoDelete: wrapStmt(db.prepare("DELETE FROM git_repos WHERE id = ?")),

		objInsert: wrapStmt(
			db.prepare(
				"INSERT OR IGNORE INTO git_objects (repo_id, hash, type, content) VALUES (?, ?, ?, ?)",
			),
		),
		objRead: wrapStmt(
			db.prepare("SELECT type, content FROM git_objects WHERE repo_id = ? AND hash = ?"),
		),
		objExists: wrapStmt(
			db.prepare("SELECT 1 FROM git_objects WHERE repo_id = ? AND hash = ? LIMIT 1"),
		),
		objPrefix: wrapStmt(
			db.prepare("SELECT hash FROM git_objects WHERE repo_id = ? AND hash GLOB ?"),
		),
		objDeleteAll: wrapStmt(db.prepare("DELETE FROM git_objects WHERE repo_id = ?")),
		objListHashes: wrapStmt(db.prepare("SELECT hash FROM git_objects WHERE repo_id = ?")),
		objDelete: wrapStmt(db.prepare("DELETE FROM git_objects WHERE repo_id = ? AND hash = ?")),

		refRead: wrapStmt(
			db.prepare("SELECT type, hash, target FROM git_refs WHERE repo_id = ? AND name = ?"),
		),
		refWrite: wrapStmt(
			db.prepare(
				"INSERT OR REPLACE INTO git_refs (repo_id, name, type, hash, target) VALUES (?, ?, ?, ?, ?)",
			),
		),
		refDelete: wrapStmt(db.prepare("DELETE FROM git_refs WHERE repo_id = ? AND name = ?")),
		refList: wrapStmt(
			db.prepare("SELECT name, type, hash, target FROM git_refs WHERE repo_id = ? AND name GLOB ?"),
		),
		refListAll: wrapStmt(
			db.prepare("SELECT name, type, hash, target FROM git_refs WHERE repo_id = ?"),
		),
		refDeleteAll: wrapStmt(db.prepare("DELETE FROM git_refs WHERE repo_id = ?")),

		forkInsert: wrapStmt(db.prepare("INSERT INTO git_forks (repo_id, parent_id) VALUES (?, ?)")),
		forkGetParent: wrapStmt(db.prepare("SELECT parent_id FROM git_forks WHERE repo_id = ?")),
		forkListChildren: wrapStmt(db.prepare("SELECT repo_id FROM git_forks WHERE parent_id = ?")),
		forkDelete: wrapStmt(db.prepare("DELETE FROM git_forks WHERE repo_id = ?")),
	};
}

// ── BetterSqlite3Storage ─────────────────────────────────────────────

/**
 * SQLite-backed storage using `better-sqlite3`.
 *
 * ```ts
 * import Database from "better-sqlite3";
 * const storage = createStorageAdapter(new BetterSqlite3Storage(new Database("repos.db")));
 * ```
 */
export class BetterSqlite3Storage implements Storage {
	private stmts: Statements;
	private objectReadManyStatements = new Map<number, Statement>();
	private objectExistsManyStatements = new Map<number, Statement>();
	private batchInsertTx: (
		rows: ReadonlyArray<{ repoId: string; hash: string; type: string; content: Uint8Array }>,
	) => string[];
	private batchDeleteTx: (
		repoId: string,
		hashes: ReadonlyArray<string>,
		onCount: (n: number) => void,
	) => void;

	constructor(private db: BetterSqlite3Database) {
		db.exec(SCHEMA);
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
				const inserted: string[] = [];
				for (const row of rows) {
					if (this.stmts.objExists.get(row.repoId, row.hash) !== null) continue;
					this.stmts.objInsert.run(row.repoId, row.hash, row.type, row.content);
					inserted.push(row.hash);
				}
				return inserted;
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
		this.stmts.forkDelete.run(repoId);
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

	getObjects(repoId: string, hashes: ReadonlyArray<string>): Map<string, RawObject> {
		const uniqueHashes = Array.from(new Set(hashes));
		if (uniqueHashes.length === 0) return new Map();
		if (uniqueHashes.length === 1) {
			const obj = this.getObject(repoId, uniqueHashes[0]!);
			return obj ? new Map([[uniqueHashes[0]!, obj]]) : new Map();
		}
		const stmt = this.getObjectReadManyStatement(uniqueHashes.length);
		const rows = stmt.all(repoId, ...uniqueHashes) as Array<{
			hash: string;
			type: string;
			content: Uint8Array;
		}>;
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
		this.stmts.objInsert.run(repoId, hash, type, content);
	}

	putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): string[] {
		return this.batchInsertTx(objects.map((o) => ({ repoId, ...o })));
	}

	hasObject(repoId: string, hash: string): boolean {
		return this.stmts.objExists.get(repoId, hash) !== null;
	}

	hasObjects(repoId: string, hashes: ReadonlyArray<string>): Set<string> {
		const uniqueHashes = Array.from(new Set(hashes));
		if (uniqueHashes.length === 0) return new Set();
		if (uniqueHashes.length === 1) {
			return this.hasObject(repoId, uniqueHashes[0]!) ? new Set(uniqueHashes) : new Set();
		}
		const stmt = this.getObjectExistsManyStatement(uniqueHashes.length);
		const rows = stmt.all(repoId, ...uniqueHashes) as Array<{ hash: string }>;
		return new Set(rows.map((row) => row.hash));
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
		const uniqueHashes = Array.from(new Set(hashes));
		const existing = this.hasObjects(repoId, uniqueHashes);
		if (existing.size === 0) return 0;
		let deleted = 0;
		this.batchDeleteTx(repoId, Array.from(existing), (count) => {
			deleted += count;
		});
		return deleted;
	}

	private getObjectReadManyStatement(count: number): Statement {
		return this.getCachedStatement(
			this.objectReadManyStatements,
			count,
			`SELECT hash, type, content FROM git_objects WHERE repo_id = ? AND hash IN (${placeholders(count)})`,
		);
	}

	private getObjectExistsManyStatement(count: number): Statement {
		return this.getCachedStatement(
			this.objectExistsManyStatements,
			count,
			`SELECT hash FROM git_objects WHERE repo_id = ? AND hash IN (${placeholders(count)})`,
		);
	}

	private getCachedStatement(cache: Map<number, Statement>, count: number, sql: string): Statement {
		let stmt = cache.get(count);
		if (!stmt) {
			stmt = wrapStmt(this.db.prepare(sql));
			cache.set(count, stmt);
		}
		return stmt;
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

	// ── Forks ───────────────────────────────────────────────────

	forkRepo(sourceId: string, targetId: string): void {
		this.stmts.forkInsert.run(targetId, sourceId);
	}

	getForkParent(repoId: string): string | null {
		const row = this.stmts.forkGetParent.get(repoId) as { parent_id: string } | null;
		return row?.parent_id ?? null;
	}

	listForks(repoId: string): string[] {
		const rows = this.stmts.forkListChildren.all(repoId) as Array<{ repo_id: string }>;
		return rows.map((r) => r.repo_id);
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
