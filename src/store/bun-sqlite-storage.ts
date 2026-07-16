import type { Ref } from "../lib/types.ts";
import type { DeltaObjectRow, ObjectRow, RawRefEntry, RefRow, StoredObject } from "./repo-store.ts";
import type { RepoPool } from "./repo-pool.ts";
import { compareAndSwapRawRef, type RepoStorage } from "./repo-storage.ts";

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

// ── Prepared statement cache ────────────────────────────────────────

interface Statements {
	repoInsert: BunSqliteStatement;
	repoExists: BunSqliteStatement;
	repoDelete: BunSqliteStatement;

	objInsert: BunSqliteStatement;
	objReplace: BunSqliteStatement;
	objRead: BunSqliteStatement;
	objExists: BunSqliteStatement;
	objPrefix: BunSqliteStatement;
	objDeleteAll: BunSqliteStatement;
	objListHashes: BunSqliteStatement;
	objByteSize: BunSqliteStatement;
	objDelete: BunSqliteStatement;

	refRead: BunSqliteStatement;
	refWrite: BunSqliteStatement;
	refDelete: BunSqliteStatement;
	refList: BunSqliteStatement;
	refListAll: BunSqliteStatement;
	refDeleteAll: BunSqliteStatement;

	forkInsert: BunSqliteStatement;
	forkGetParent: BunSqliteStatement;
	forkListChildren: BunSqliteStatement;
	forkDelete: BunSqliteStatement;
}

function prepareStatements(db: BunSqliteDatabase): Statements {
	return {
		repoInsert: db.prepare("INSERT INTO git_repos (id) VALUES (?)"),
		repoExists: db.prepare("SELECT 1 FROM git_repos WHERE id = ? LIMIT 1"),
		repoDelete: db.prepare("DELETE FROM git_repos WHERE id = ?"),

		objInsert: db.prepare(
			"INSERT OR IGNORE INTO git_objects (repo_id, hash, type, content) VALUES (?, ?, ?, ?) RETURNING hash",
		),
		objReplace: db.prepare(
			"INSERT OR REPLACE INTO git_objects (repo_id, hash, type, content, encoding, base_hash) VALUES (?, ?, ?, ?, ?, ?)",
		),
		objRead: db.prepare(
			"SELECT type, content, encoding, base_hash FROM git_objects WHERE repo_id = ? AND hash = ?",
		),
		objExists: db.prepare("SELECT 1 FROM git_objects WHERE repo_id = ? AND hash = ? LIMIT 1"),
		objPrefix: db.prepare("SELECT hash FROM git_objects WHERE repo_id = ? AND hash GLOB ?"),
		objDeleteAll: db.prepare("DELETE FROM git_objects WHERE repo_id = ?"),
		objListHashes: db.prepare("SELECT hash FROM git_objects WHERE repo_id = ?"),
		objByteSize: db.prepare(
			"SELECT COALESCE(SUM(LENGTH(content)), 0) AS size FROM git_objects WHERE repo_id = ?",
		),
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

		forkInsert: db.prepare("INSERT INTO git_forks (repo_id, parent_id) VALUES (?, ?)"),
		forkGetParent: db.prepare("SELECT parent_id FROM git_forks WHERE repo_id = ?"),
		forkListChildren: db.prepare("SELECT repo_id FROM git_forks WHERE parent_id = ?"),
		forkDelete: db.prepare("DELETE FROM git_forks WHERE repo_id = ?"),
	};
}

// ── BunSqliteStorage ─────────────────────────────────────────────────

/**
 * SQLite-backed storage using `bun:sqlite`.
 *
 * ```ts
 * import { Database } from "bun:sqlite";
 * const storage = createRepoStore(new BunSqliteStorage(new Database("repos.db")));
 * ```
 */
export class BunSqliteStorage implements RepoPool {
	private stmts: Statements;
	private objectReadManyStatements = new Map<number, BunSqliteStatement>();
	private objectExistsManyStatements = new Map<number, BunSqliteStatement>();
	private batchInsertTx: (
		rows: ReadonlyArray<{ repoId: string; hash: string; type: string; content: Uint8Array }>,
	) => string[];
	private batchReplaceTx: (repoId: string, rows: ReadonlyArray<DeltaObjectRow>) => void;
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
				const inserted: string[] = [];
				for (const row of rows) {
					const result = this.stmts.objInsert.get(row.repoId, row.hash, row.type, row.content);
					if (result) inserted.push(result.hash);
				}
				return inserted;
			},
		);
		this.batchReplaceTx = db.transaction((repoId: string, rows: ReadonlyArray<DeltaObjectRow>) => {
			for (const row of rows) {
				const baseHash = "baseHash" in row ? row.baseHash : null;
				this.stmts.objReplace.run(repoId, row.hash, row.type, row.content, row.encoding, baseHash);
			}
		});
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

	createRepo(repoId: string): void {
		this.stmts.repoInsert.run(repoId);
	}

	deleteRepo(repoId: string): void {
		this.stmts.repoDelete.run(repoId);
		this.stmts.objDeleteAll.run(repoId);
		this.stmts.refDeleteAll.run(repoId);
		this.stmts.forkDelete.run(repoId);
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
		return rowToStored(this.stmts.objRead.get(repoId, hash) as ObjectRow | null);
	}

	private getObjects(repoId: string, hashes: ReadonlyArray<string>): Map<string, StoredObject> {
		const uniqueHashes = Array.from(new Set(hashes));
		if (uniqueHashes.length === 0) return new Map();
		if (uniqueHashes.length === 1) {
			const obj = this.getObject(repoId, uniqueHashes[0]!);
			return obj ? new Map([[uniqueHashes[0]!, obj]]) : new Map();
		}
		const stmt = this.getObjectReadManyStatement(uniqueHashes.length);
		const rows = stmt.all(repoId, ...uniqueHashes) as ObjectRow[];
		const result = new Map<string, StoredObject>();
		for (const row of rows) {
			const stored = rowToStored(row);
			if (stored) result.set(row.hash!, stored);
		}
		return result;
	}

	private putObject(repoId: string, hash: string, type: string, content: Uint8Array): void {
		this.stmts.objInsert.run(repoId, hash, type, content);
	}

	private putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): string[] {
		return this.batchInsertTx(objects.map((o) => ({ repoId, ...o })));
	}

	private putDeltaObjects(repoId: string, rows: ReadonlyArray<DeltaObjectRow>): void {
		if (rows.length === 0) return;
		this.batchReplaceTx(repoId, rows);
	}

	private hasObject(repoId: string, hash: string): boolean {
		return this.stmts.objExists.get(repoId, hash) !== null;
	}

	private hasObjects(repoId: string, hashes: ReadonlyArray<string>): Set<string> {
		const uniqueHashes = Array.from(new Set(hashes));
		if (uniqueHashes.length === 0) return new Set();
		if (uniqueHashes.length === 1) {
			return this.hasObject(repoId, uniqueHashes[0]!) ? new Set(uniqueHashes) : new Set();
		}
		const stmt = this.getObjectExistsManyStatement(uniqueHashes.length);
		const rows = stmt.all(repoId, ...uniqueHashes) as Array<{ hash: string }>;
		return new Set(rows.map((row) => row.hash));
	}

	private findObjectsByPrefix(repoId: string, prefix: string): string[] {
		const rows = this.stmts.objPrefix.all(repoId, `${prefix}*`) as Array<{ hash: string }>;
		return rows.map((r) => r.hash);
	}

	private listObjectHashes(repoId: string): string[] {
		const rows = this.stmts.objListHashes.all(repoId) as Array<{ hash: string }>;
		return rows.map((r) => r.hash);
	}

	private repoByteSize(repoId: string): number {
		const row = this.stmts.objByteSize.get(repoId) as { size: number } | null;
		return row ? Number(row.size) : 0;
	}

	private deleteObjects(repoId: string, hashes: ReadonlyArray<string>): number {
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

	private getObjectReadManyStatement(count: number): BunSqliteStatement {
		return this.getCachedStatement(
			this.objectReadManyStatements,
			count,
			`SELECT hash, type, content, encoding, base_hash FROM git_objects WHERE repo_id = ? AND hash IN (${placeholders(count)})`,
		);
	}

	private getObjectExistsManyStatement(count: number): BunSqliteStatement {
		return this.getCachedStatement(
			this.objectExistsManyStatements,
			count,
			`SELECT hash FROM git_objects WHERE repo_id = ? AND hash IN (${placeholders(count)})`,
		);
	}

	private getCachedStatement(
		cache: Map<number, BunSqliteStatement>,
		count: number,
		sql: string,
	): BunSqliteStatement {
		let stmt = cache.get(count);
		if (!stmt) {
			stmt = this.db.prepare(sql);
			cache.set(count, stmt);
		}
		return stmt;
	}

	// ── Refs ────────────────────────────────────────────────────

	private getRef(repoId: string, name: string): Ref | null {
		const row = this.stmts.refRead.get(repoId, name) as RefRow | null;
		return rowToRef(row);
	}

	private putRef(repoId: string, name: string, ref: Ref): void {
		if (ref.type === "symbolic") {
			this.stmts.refWrite.run(repoId, name, "symbolic", null, ref.target);
		} else {
			this.stmts.refWrite.run(repoId, name, "direct", ref.hash, null);
		}
	}

	private removeRef(repoId: string, name: string): void {
		this.stmts.refDelete.run(repoId, name);
	}

	private listRefs(repoId: string, prefix?: string): RawRefEntry[] {
		const rows: RefRow[] = prefix
			? (this.stmts.refList.all(repoId, `${prefix}*`) as RefRow[])
			: (this.stmts.refListAll.all(repoId) as RefRow[]);
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
		const tx = this.db.transaction(() => {
			return compareAndSwapRawRef(
				() => this.getRef(repoId, name),
				(ref) => this.putRef(repoId, name, ref),
				() => this.removeRef(repoId, name),
				expectedOld,
				newRef,
			);
		});
		return tx();
	}

	// ── Forks ───────────────────────────────────────────────────

	fork(sourceId: string, targetId: string): void {
		this.stmts.forkInsert.run(targetId, sourceId);
	}

	parentOf(repoId: string): string | null {
		const row = this.stmts.forkGetParent.get(repoId) as { parent_id: string } | null;
		return row?.parent_id ?? null;
	}

	forksOf(repoId: string): string[] {
		const rows = this.stmts.forkListChildren.all(repoId) as Array<{ repo_id: string }>;
		return rows.map((r) => r.repo_id);
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
