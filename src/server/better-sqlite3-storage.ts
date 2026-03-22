import { ObjectCache } from "../lib/object-cache.ts";
import { envelope } from "../lib/object-store.ts";
import type { PackObject } from "../lib/pack/packfile.ts";
import { readPack } from "../lib/pack/packfile.ts";
import { sha1 } from "../lib/sha1.ts";
import { normalizeRef } from "../lib/types.ts";
import type {
	ObjectId,
	ObjectStore,
	ObjectType,
	RawObject,
	Ref,
	RefEntry,
	RefStore,
	GitRepo,
} from "../lib/types.ts";
import type { Storage, CreateRepoOptions } from "./storage.ts";

// ── better-sqlite3 driver types ─────────────────────────────────────

/** Minimal prepared statement interface matching `better-sqlite3`. */
export interface BetterSqlite3Statement {
	run(...params: any[]): any;
	get(...params: any[]): any;
	all(...params: any[]): any[];
}

/** Minimal database interface matching the `better-sqlite3` `Database` class. */
export interface BetterSqlite3Database {
	exec(sql: string): any;
	prepare(sql: string): BetterSqlite3Statement;
	transaction<F extends (...args: any[]) => any>(fn: F): (...args: Parameters<F>) => ReturnType<F>;
}

// ── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id              TEXT PRIMARY KEY,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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

// ── Normalized statement interface ──────────────────────────────────
// better-sqlite3's .get() returns undefined for no match; we normalize
// to null at preparation time so the storage code can stay uniform.

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
	repoList: Statement;

	objInsert: Statement;
	objRead: Statement;
	objExists: Statement;
	objPrefix: Statement;
	objDeleteAll: Statement;

	refRead: Statement;
	refWrite: Statement;
	refDelete: Statement;
	refList: Statement;
	refListAll: Statement;
	refDeleteAll: Statement;
}

function prepareStatements(db: BetterSqlite3Database): Statements {
	return {
		repoInsert: wrapStmt(db.prepare("INSERT INTO repos (id, default_branch) VALUES (?, ?)")),
		repoExists: wrapStmt(db.prepare("SELECT 1 FROM repos WHERE id = ? LIMIT 1")),
		repoDelete: wrapStmt(db.prepare("DELETE FROM repos WHERE id = ?")),
		repoList: wrapStmt(db.prepare("SELECT id FROM repos ORDER BY created_at")),

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
	};
}

// ── BetterSqlite3Storage ────────────────────────────────────────────

/**
 * SQLite-backed git storage using `better-sqlite3`.
 *
 * ```ts
 * import Database from "better-sqlite3";
 * const storage = new BetterSqlite3Storage(new Database("repos.db"));
 * storage.createRepo("my-repo");
 * ```
 */
export class BetterSqlite3Storage implements Storage {
	private db: BetterSqlite3Database;
	private stmts: Statements;
	private ingestTx: (
		rows: Array<{ repoId: string; hash: string; type: string; content: Uint8Array }>,
	) => void;

	constructor(db: BetterSqlite3Database) {
		this.db = db;
		db.exec(SCHEMA);
		this.stmts = prepareStatements(db);
		this.ingestTx = db.transaction(
			(rows: Array<{ repoId: string; hash: string; type: string; content: Uint8Array }>) => {
				for (const row of rows) {
					this.stmts.objInsert.run(row.repoId, row.hash, row.type, row.content);
				}
			},
		);
	}

	createRepo(repoId: string, options?: CreateRepoOptions): GitRepo {
		if (this.stmts.repoExists.get(repoId)) {
			throw new Error(`repo '${repoId}' already exists`);
		}
		const defaultBranch = options?.defaultBranch ?? "main";
		this.stmts.repoInsert.run(repoId, defaultBranch);
		this.stmts.refWrite.run(repoId, "HEAD", "symbolic", null, `refs/heads/${defaultBranch}`);
		return this.buildRepo(repoId);
	}

	repo(repoId: string): GitRepo | null {
		if (!this.stmts.repoExists.get(repoId)) return null;
		return this.buildRepo(repoId);
	}

	deleteRepo(repoId: string): void {
		this.stmts.repoDelete.run(repoId);
		this.stmts.objDeleteAll.run(repoId);
		this.stmts.refDeleteAll.run(repoId);
	}

	listRepos(): string[] {
		return (this.stmts.repoList.all() as Array<{ id: string }>).map((r) => r.id);
	}

	private buildRepo(repoId: string): GitRepo {
		return {
			objectStore: new BetterSqlite3ObjectStore(this.stmts, this.ingestTx, repoId),
			refStore: new BetterSqlite3RefStore(this.stmts, this.db, repoId),
		};
	}
}

// ── BetterSqlite3ObjectStore ────────────────────────────────────────

class BetterSqlite3ObjectStore implements ObjectStore {
	private cache: ObjectCache;

	constructor(
		private stmts: Statements,
		private ingestTx: (
			rows: Array<{ repoId: string; hash: string; type: string; content: Uint8Array }>,
		) => void,
		private repoId: string,
	) {
		this.cache = new ObjectCache();
	}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		const data = envelope(type, content);
		const hash = await sha1(data);
		this.stmts.objInsert.run(this.repoId, hash, type, content);
		return hash;
	}

	async read(hash: ObjectId): Promise<RawObject> {
		const cached = this.cache.get(hash);
		if (cached) return cached;

		const row = this.stmts.objRead.get(this.repoId, hash) as {
			type: string;
			content: Uint8Array;
		} | null;
		if (!row) {
			throw new Error(`object ${hash} not found`);
		}
		const obj: RawObject = {
			type: row.type as ObjectType,
			content: new Uint8Array(row.content),
		};
		this.cache.set(hash, obj);
		return obj;
	}

	async exists(hash: ObjectId): Promise<boolean> {
		return this.stmts.objExists.get(this.repoId, hash) !== null;
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		if (packData.byteLength < 32) return 0;
		const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);
		const numObjects = view.getUint32(8);
		if (numObjects === 0) return 0;

		const entries = await readPack(packData, async (hash) => {
			const row = this.stmts.objRead.get(this.repoId, hash) as {
				type: string;
				content: Uint8Array;
			} | null;
			if (!row) return null;
			return { type: row.type as ObjectType, content: new Uint8Array(row.content) };
		});

		const rows = entries.map((entry) => ({
			repoId: this.repoId,
			hash: entry.hash,
			type: entry.type,
			content: entry.content,
		}));

		this.ingestTx(rows);

		return entries.length;
	}

	async ingestPackStream(entries: AsyncIterable<PackObject>): Promise<number> {
		const rows: Array<{ repoId: string; hash: string; type: string; content: Uint8Array }> = [];
		for await (const entry of entries) {
			rows.push({
				repoId: this.repoId,
				hash: entry.hash,
				type: entry.type,
				content: entry.content,
			});
		}
		if (rows.length === 0) return 0;
		this.ingestTx(rows);
		return rows.length;
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		if (prefix.length < 4) return [];
		const rows = this.stmts.objPrefix.all(this.repoId, `${prefix}*`) as Array<{
			hash: string;
		}>;
		return rows.map((r) => r.hash);
	}
}

// ── BetterSqlite3RefStore ───────────────────────────────────────────

class BetterSqlite3RefStore implements RefStore {
	private casTx: (name: string, expectedOldHash: string | null, newRef: Ref | null) => boolean;

	constructor(
		private stmts: Statements,
		db: BetterSqlite3Database,
		private repoId: string,
	) {
		const s = stmts;
		const rid = repoId;

		this.casTx = db.transaction(
			(name: string, expectedOldHash: string | null, newRef: Ref | null): boolean => {
				const row = s.refRead.get(rid, name) as RefRow | null;

				let currentHash: string | null = null;
				if (row) {
					if (row.type === "direct") {
						currentHash = row.hash;
					} else if (row.type === "symbolic" && row.target) {
						currentHash = resolveRefChainSync(s, rid, row.target);
					}
				}

				if (expectedOldHash === null) {
					if (row !== null) return false;
				} else {
					if (currentHash !== expectedOldHash) return false;
				}

				if (newRef === null) {
					s.refDelete.run(rid, name);
				} else if (newRef.type === "symbolic") {
					s.refWrite.run(rid, name, "symbolic", null, newRef.target);
				} else {
					s.refWrite.run(rid, name, "direct", newRef.hash, null);
				}
				return true;
			},
		);
	}

	async readRef(name: string): Promise<Ref | null> {
		const row = this.stmts.refRead.get(this.repoId, name) as RefRow | null;
		if (!row) return null;
		if (row.type === "symbolic") {
			return { type: "symbolic", target: row.target! };
		}
		return { type: "direct", hash: row.hash! };
	}

	async writeRef(name: string, refOrHash: Ref | string): Promise<void> {
		const ref = normalizeRef(refOrHash);
		if (ref.type === "symbolic") {
			this.stmts.refWrite.run(this.repoId, name, "symbolic", null, ref.target);
		} else {
			this.stmts.refWrite.run(this.repoId, name, "direct", ref.hash, null);
		}
	}

	async deleteRef(name: string): Promise<void> {
		this.stmts.refDelete.run(this.repoId, name);
	}

	async compareAndSwapRef(
		name: string,
		expectedOldHash: string | null,
		newRef: Ref | null,
	): Promise<boolean> {
		return this.casTx(name, expectedOldHash, newRef);
	}

	async listRefs(prefix?: string): Promise<RefEntry[]> {
		let rows: Array<RefRow>;
		if (prefix) {
			rows = this.stmts.refList.all(this.repoId, `${prefix}*`) as Array<RefRow>;
		} else {
			rows = this.stmts.refListAll.all(this.repoId) as Array<RefRow>;
		}

		const results: RefEntry[] = [];
		for (const row of rows) {
			if (row.type === "direct" && row.hash) {
				results.push({ name: row.name, hash: row.hash });
			} else if (row.type === "symbolic" && row.target) {
				const resolved = resolveRefChainSync(this.stmts, this.repoId, row.target);
				if (resolved) {
					results.push({ name: row.name, hash: resolved });
				}
			}
		}
		return results;
	}
}

// ── Shared helpers ──────────────────────────────────────────────────

type RefRow = { name: string; type: string; hash: string | null; target: string | null };

function resolveRefChainSync(
	stmts: Statements,
	repoId: string,
	target: string,
	depth = 0,
): string | null {
	if (depth > 10) return null;
	const row = stmts.refRead.get(repoId, target) as RefRow | null;
	if (!row) return null;
	if (row.type === "direct") return row.hash;
	if (row.type === "symbolic" && row.target) {
		return resolveRefChainSync(stmts, repoId, row.target, depth + 1);
	}
	return null;
}
