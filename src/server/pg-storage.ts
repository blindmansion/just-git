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

// ── Postgres driver interface ───────────────────────────────────────

/** Minimal database interface for PostgreSQL. Use {@link wrapPgPool} to adapt a `pg` Pool. */
export interface PgDatabase {
	query<T = any>(text: string, values?: any[]): Promise<{ rows: T[] }>;
	transaction<R>(fn: (tx: PgDatabase) => Promise<R>): Promise<R>;
}

// ── pg Pool adapter ─────────────────────────────────────────────────

/** Minimal pool interface matching the `pg` package's `Pool` class. */
export interface PgPool {
	query(text: string, values?: any[]): Promise<{ rows: any[] }>;
	connect(): Promise<PgPoolClient>;
}

/** Minimal pool client interface matching the `pg` package's `PoolClient`. */
export interface PgPoolClient {
	query(text: string, values?: any[]): Promise<{ rows: any[] }>;
	release(): void;
}

/**
 * Wrap a `pg`-style pool into a `PgDatabase`.
 *
 * Handles `BEGIN`/`COMMIT`/`ROLLBACK` and client release automatically.
 *
 * ```ts
 * import { Pool } from "pg";
 * const pool = new Pool({ connectionString: "..." });
 * const db = wrapPgPool(pool);
 * ```
 */
export function wrapPgPool(pool: PgPool): PgDatabase {
	return {
		query: (text, values) => pool.query(text, values),
		async transaction<R>(fn: (tx: PgDatabase) => Promise<R>): Promise<R> {
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				const tx: PgDatabase = {
					query: (text, values) => client.query(text, values),
					transaction: () => {
						throw new Error("nested transactions not supported");
					},
				};
				const result = await fn(tx);
				await client.query("COMMIT");
				return result;
			} catch (err) {
				await client.query("ROLLBACK");
				throw err;
			} finally {
				client.release();
			}
		},
	};
}

// ── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS git_objects (
  repo_id TEXT NOT NULL,
  hash    TEXT NOT NULL,
  type    TEXT NOT NULL,
  content BYTEA NOT NULL,
  PRIMARY KEY (repo_id, hash)
);

CREATE TABLE IF NOT EXISTS git_refs (
  repo_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  type    TEXT NOT NULL CHECK(type IN ('direct', 'symbolic')),
  hash    TEXT,
  target  TEXT,
  PRIMARY KEY (repo_id, name)
);
`;

// ── SQL queries ─────────────────────────────────────────────────────

const SQL = {
	repoInsert: "INSERT INTO repos (id) VALUES ($1)",
	repoExists: "SELECT 1 FROM repos WHERE id = $1 LIMIT 1",
	repoDelete: "DELETE FROM repos WHERE id = $1",

	objInsert:
		"INSERT INTO git_objects (repo_id, hash, type, content) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
	objRead: "SELECT type, content FROM git_objects WHERE repo_id = $1 AND hash = $2",
	objExists: "SELECT 1 FROM git_objects WHERE repo_id = $1 AND hash = $2 LIMIT 1",
	objPrefix: "SELECT hash FROM git_objects WHERE repo_id = $1 AND hash LIKE $2",
	objDeleteAll: "DELETE FROM git_objects WHERE repo_id = $1",

	refRead: "SELECT type, hash, target FROM git_refs WHERE repo_id = $1 AND name = $2",
	refReadForUpdate:
		"SELECT type, hash, target FROM git_refs WHERE repo_id = $1 AND name = $2 FOR UPDATE",
	refWrite: `INSERT INTO git_refs (repo_id, name, type, hash, target) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (repo_id, name) DO UPDATE SET type = EXCLUDED.type, hash = EXCLUDED.hash, target = EXCLUDED.target`,
	refDelete: "DELETE FROM git_refs WHERE repo_id = $1 AND name = $2",
	refList: "SELECT name, type, hash, target FROM git_refs WHERE repo_id = $1 AND name LIKE $2",
	refListAll: "SELECT name, type, hash, target FROM git_refs WHERE repo_id = $1",
	refDeleteAll: "DELETE FROM git_refs WHERE repo_id = $1",
} as const;

// ── PgStorage ───────────────────────────────────────────────────────

/**
 * PostgreSQL-backed git storage with multi-repo support.
 *
 * Creates and manages `repos`, `git_objects`, and `git_refs` tables
 * in the provided database. Multiple repos are partitioned by ID.
 *
 * Use the static `create` factory (schema setup is async):
 *
 * ```ts
 * import { Pool } from "pg";
 * const pool = new Pool({ connectionString: "..." });
 * const storage = await PgStorage.create(wrapPgPool(pool));
 * await storage.createRepo("my-repo");
 * ```
 */
export class PgStorage implements Storage {
	private constructor(private db: PgDatabase) {}

	static async create(db: PgDatabase): Promise<PgStorage> {
		await db.query(SCHEMA);
		return new PgStorage(db);
	}

	async createRepo(repoId: string, options?: CreateRepoOptions): Promise<GitRepo> {
		const { rows } = await this.db.query(SQL.repoExists, [repoId]);
		if (rows.length > 0) {
			throw new Error(`repo '${repoId}' already exists`);
		}
		const defaultBranch = options?.defaultBranch ?? "main";
		await this.db.query(SQL.repoInsert, [repoId]);
		await this.db.query(SQL.refWrite, [
			repoId,
			"HEAD",
			"symbolic",
			null,
			`refs/heads/${defaultBranch}`,
		]);
		return this.buildRepo(repoId);
	}

	async repo(repoId: string): Promise<GitRepo | null> {
		const { rows } = await this.db.query(SQL.repoExists, [repoId]);
		if (rows.length === 0) return null;
		return this.buildRepo(repoId);
	}

	async deleteRepo(repoId: string): Promise<void> {
		await this.db.query(SQL.repoDelete, [repoId]);
		await this.db.query(SQL.objDeleteAll, [repoId]);
		await this.db.query(SQL.refDeleteAll, [repoId]);
	}

	private buildRepo(repoId: string): GitRepo {
		return {
			objectStore: new PgObjectStore(this.db, repoId),
			refStore: new PgRefStore(this.db, repoId),
		};
	}
}

// ── PgObjectStore ───────────────────────────────────────────────────

class PgObjectStore implements ObjectStore {
	private cache: ObjectCache;

	constructor(
		private db: PgDatabase,
		private repoId: string,
	) {
		this.cache = new ObjectCache();
	}

	async write(type: ObjectType, content: Uint8Array): Promise<ObjectId> {
		const data = envelope(type, content);
		const hash = await sha1(data);
		await this.db.query(SQL.objInsert, [this.repoId, hash, type, content]);
		return hash;
	}

	async read(hash: ObjectId): Promise<RawObject> {
		const cached = this.cache.get(hash);
		if (cached) return cached;

		const { rows } = await this.db.query<{ type: string; content: Uint8Array }>(SQL.objRead, [
			this.repoId,
			hash,
		]);
		const row = rows[0];
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
		const { rows } = await this.db.query(SQL.objExists, [this.repoId, hash]);
		return rows.length > 0;
	}

	async ingestPack(packData: Uint8Array): Promise<number> {
		if (packData.byteLength < 32) return 0;
		const view = new DataView(packData.buffer, packData.byteOffset, packData.byteLength);
		const numObjects = view.getUint32(8);
		if (numObjects === 0) return 0;

		const db = this.db;
		const repoId = this.repoId;

		const entries = await readPack(packData, async (hash) => {
			const { rows } = await db.query<{ type: string; content: Uint8Array }>(SQL.objRead, [
				repoId,
				hash,
			]);
			const row = rows[0];
			if (!row) return null;
			return { type: row.type as ObjectType, content: new Uint8Array(row.content) };
		});

		await db.transaction(async (tx) => {
			for (const entry of entries) {
				await tx.query(SQL.objInsert, [repoId, entry.hash, entry.type, entry.content]);
			}
		});

		return entries.length;
	}

	async ingestPackStream(entries: AsyncIterable<PackObject>): Promise<number> {
		const db = this.db;
		const repoId = this.repoId;
		let count = 0;
		await db.transaction(async (tx) => {
			for await (const entry of entries) {
				await tx.query(SQL.objInsert, [repoId, entry.hash, entry.type, entry.content]);
				count++;
			}
		});
		return count;
	}

	async findByPrefix(prefix: string): Promise<ObjectId[]> {
		if (prefix.length < 4) return [];
		const { rows } = await this.db.query<{ hash: string }>(SQL.objPrefix, [
			this.repoId,
			`${prefix}%`,
		]);
		return rows.map((r) => r.hash);
	}
}

// ── PgRefStore ──────────────────────────────────────────────────────

class PgRefStore implements RefStore {
	constructor(
		private db: PgDatabase,
		private repoId: string,
	) {}

	async readRef(name: string): Promise<Ref | null> {
		const { rows } = await this.db.query<RefRow>(SQL.refRead, [this.repoId, name]);
		const row = rows[0];
		if (!row) return null;
		if (row.type === "symbolic") {
			return { type: "symbolic", target: row.target! };
		}
		return { type: "direct", hash: row.hash! };
	}

	async writeRef(name: string, refOrHash: Ref | string): Promise<void> {
		const ref = normalizeRef(refOrHash);
		if (ref.type === "symbolic") {
			await this.db.query(SQL.refWrite, [this.repoId, name, "symbolic", null, ref.target]);
		} else {
			await this.db.query(SQL.refWrite, [this.repoId, name, "direct", ref.hash, null]);
		}
	}

	async deleteRef(name: string): Promise<void> {
		await this.db.query(SQL.refDelete, [this.repoId, name]);
	}

	async compareAndSwapRef(
		name: string,
		expectedOldHash: string | null,
		newRef: Ref | null,
	): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			const { rows } = await tx.query<RefRow>(SQL.refReadForUpdate, [this.repoId, name]);
			const row = rows[0] ?? null;

			let currentHash: string | null = null;
			if (row) {
				if (row.type === "direct") {
					currentHash = row.hash;
				} else if (row.type === "symbolic" && row.target) {
					currentHash = await resolveRefChain(tx, this.repoId, row.target);
				}
			}

			if (expectedOldHash === null) {
				if (row !== null) return false;
			} else {
				if (currentHash !== expectedOldHash) return false;
			}

			if (newRef === null) {
				await tx.query(SQL.refDelete, [this.repoId, name]);
			} else if (newRef.type === "symbolic") {
				await tx.query(SQL.refWrite, [this.repoId, name, "symbolic", null, newRef.target]);
			} else {
				await tx.query(SQL.refWrite, [this.repoId, name, "direct", newRef.hash, null]);
			}
			return true;
		});
	}

	async listRefs(prefix?: string): Promise<RefEntry[]> {
		let rows: RefRow[];
		if (prefix) {
			({ rows } = await this.db.query<RefRow>(SQL.refList, [this.repoId, `${prefix}%`]));
		} else {
			({ rows } = await this.db.query<RefRow>(SQL.refListAll, [this.repoId]));
		}

		const results: RefEntry[] = [];
		for (const row of rows) {
			if (row.type === "direct" && row.hash) {
				results.push({ name: row.name, hash: row.hash });
			} else if (row.type === "symbolic" && row.target) {
				const resolved = await resolveRefChain(this.db, this.repoId, row.target);
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

async function resolveRefChain(
	db: PgDatabase,
	repoId: string,
	target: string,
	depth = 0,
): Promise<string | null> {
	if (depth > 10) return null;
	const { rows } = await db.query<RefRow>(SQL.refRead, [repoId, target]);
	const row = rows[0];
	if (!row) return null;
	if (row.type === "direct") return row.hash;
	if (row.type === "symbolic" && row.target) {
		return resolveRefChain(db, repoId, row.target, depth + 1);
	}
	return null;
}
