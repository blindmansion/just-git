import type { Database, Statement } from "bun:sqlite";
import { envelope } from "../lib/object-store.ts";
import { readPack } from "../lib/pack/packfile.ts";
import { sha1 } from "../lib/sha1.ts";
import type {
	ObjectId,
	ObjectStore,
	ObjectType,
	RawObject,
	Ref,
	RefEntry,
	RefStore,
} from "../lib/types.ts";
import type { GitRepo } from "../lib/types.ts";

// ── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
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

function prepareStatements(db: Database): Statements {
	return {
		objInsert: db.prepare(
			"INSERT OR IGNORE INTO git_objects (repo_id, hash, type, content) VALUES (?, ?, ?, ?)",
		),
		objRead: db.prepare("SELECT type, content FROM git_objects WHERE repo_id = ? AND hash = ?"),
		objExists: db.prepare("SELECT 1 FROM git_objects WHERE repo_id = ? AND hash = ? LIMIT 1"),
		objPrefix: db.prepare("SELECT hash FROM git_objects WHERE repo_id = ? AND hash GLOB ?"),
		objDeleteAll: db.prepare("DELETE FROM git_objects WHERE repo_id = ?"),

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

// ── SqliteStorage ───────────────────────────────────────────────────

/**
 * SQLite-backed git storage with multi-repo support.
 *
 * Creates and manages `git_objects` and `git_refs` tables in the
 * provided database. Multiple repos are partitioned by `repo_id`.
 *
 * ```ts
 * const db = new Database("repos.sqlite");
 * const storage = new SqliteStorage(db);
 * const server = createGitServer({
 *   resolve: async (repoPath) => storage.repo(repoPath),
 * });
 * ```
 */
export class SqliteStorage {
	private db: Database;
	private stmts: Statements;
	private ingestTx: ReturnType<Database["transaction"]>;

	constructor(db: Database) {
		this.db = db;
		db.run(SCHEMA);
		this.stmts = prepareStatements(db);
		this.ingestTx = db.transaction(
			(rows: Array<{ repoId: string; hash: string; type: string; content: Uint8Array }>) => {
				for (const row of rows) {
					this.stmts.objInsert.run(row.repoId, row.hash, row.type, row.content);
				}
			},
		);
	}

	/** Get a `GitRepo` scoped to a specific repo. */
	repo(repoId: string): GitRepo {
		return {
			objectStore: new SqliteObjectStore(this.stmts, this.ingestTx, repoId),
			refStore: new SqliteRefStore(this.stmts, repoId),
		};
	}

	/** Delete all objects and refs for a repo. */
	deleteRepo(repoId: string): void {
		this.stmts.objDeleteAll.run(repoId);
		this.stmts.refDeleteAll.run(repoId);
	}
}

// ── SqliteObjectStore ───────────────────────────────────────────────

class SqliteObjectStore implements ObjectStore {
	constructor(
		private stmts: Statements,
		private ingestTx: ReturnType<Database["transaction"]>,
		private repoId: string,
	) {}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		const data = envelope(type, content);
		const hash = await sha1(data);
		this.stmts.objInsert.run(this.repoId, hash, type, content);
		return hash;
	}

	async read(hash: ObjectId): Promise<RawObject> {
		const row = this.stmts.objRead.get(this.repoId, hash) as {
			type: string;
			content: Uint8Array;
		} | null;
		if (!row) {
			throw new Error(`object ${hash} not found`);
		}
		return {
			type: row.type as ObjectType,
			content: new Uint8Array(row.content),
		};
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

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		if (prefix.length < 4) return [];
		const rows = this.stmts.objPrefix.all(this.repoId, `${prefix}*`) as Array<{
			hash: string;
		}>;
		return rows.map((r) => r.hash);
	}
}

// ── SqliteRefStore ──────────────────────────────────────────────────

class SqliteRefStore implements RefStore {
	constructor(
		private stmts: Statements,
		private repoId: string,
	) {}

	async readRef(name: string): Promise<Ref | null> {
		const row = this.stmts.refRead.get(this.repoId, name) as {
			type: string;
			hash: string | null;
			target: string | null;
		} | null;
		if (!row) return null;
		if (row.type === "symbolic") {
			return { type: "symbolic", target: row.target! };
		}
		return { type: "direct", hash: row.hash! };
	}

	async writeRef(name: string, ref: Ref): Promise<void> {
		if (ref.type === "symbolic") {
			this.stmts.refWrite.run(this.repoId, name, "symbolic", null, ref.target);
		} else {
			this.stmts.refWrite.run(this.repoId, name, "direct", ref.hash, null);
		}
	}

	async deleteRef(name: string): Promise<void> {
		this.stmts.refDelete.run(this.repoId, name);
	}

	async listRefs(prefix?: string): Promise<RefEntry[]> {
		let rows: Array<{ name: string; type: string; hash: string | null; target: string | null }>;
		if (prefix) {
			rows = this.stmts.refList.all(this.repoId, `${prefix}*`) as typeof rows;
		} else {
			rows = this.stmts.refListAll.all(this.repoId) as typeof rows;
		}

		const results: RefEntry[] = [];
		for (const row of rows) {
			if (row.type === "direct" && row.hash) {
				results.push({ name: row.name, hash: row.hash });
			} else if (row.type === "symbolic" && row.target) {
				const resolved = await this.resolveSymref(row.target);
				if (resolved) {
					results.push({ name: row.name, hash: resolved });
				}
			}
		}
		return results;
	}

	private async resolveSymref(target: string, depth = 0): Promise<string | null> {
		if (depth > 10) return null;
		const ref = await this.readRef(target);
		if (!ref) return null;
		if (ref.type === "direct") return ref.hash;
		return this.resolveSymref(ref.target, depth + 1);
	}
}
