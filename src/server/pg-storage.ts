import type { RawObject, Ref } from "../lib/types.ts";
import type { Storage, RawRefEntry, RefOps } from "./storage.ts";

// ── Postgres pool interface ────────────────────────────────────────

/** Minimal pool interface matching the `pg` package's `Pool` class. */
export interface PgPool {
	query<T = any>(text: string, values?: any[]): Promise<{ rows: T[] }>;
	connect(): Promise<PgPoolClient>;
}

interface PgPoolClient {
	query<T = any>(text: string, values?: any[]): Promise<{ rows: T[] }>;
	release(): void;
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
	repoInsert: "INSERT INTO git_repos (id) VALUES ($1)",
	repoExists: "SELECT 1 FROM git_repos WHERE id = $1 LIMIT 1",
	repoDelete: "DELETE FROM git_repos WHERE id = $1",

	objInsert:
		"INSERT INTO git_objects (repo_id, hash, type, content) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
	objRead: "SELECT type, content FROM git_objects WHERE repo_id = $1 AND hash = $2",
	objExists: "SELECT 1 FROM git_objects WHERE repo_id = $1 AND hash = $2 LIMIT 1",
	objPrefix: "SELECT hash FROM git_objects WHERE repo_id = $1 AND hash LIKE $2",
	objDeleteAll: "DELETE FROM git_objects WHERE repo_id = $1",
	objListHashes: "SELECT hash FROM git_objects WHERE repo_id = $1",

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

// ── PgStorage ────────────────────────────────────────────────────────

/**
 * PostgreSQL-backed storage. Accepts a `pg`-style pool directly.
 *
 * Use the static `create` factory (schema setup is async):
 *
 * ```ts
 * import { Pool } from "pg";
 * const pool = new Pool({ connectionString: "..." });
 * const storage = await PgStorage.create(pool);
 * ```
 */
export class PgStorage implements Storage {
	private constructor(private pool: PgPool) {}

	static async create(pool: PgPool): Promise<PgStorage> {
		await pool.query(SCHEMA);
		return new PgStorage(pool);
	}

	private async transaction<R>(fn: (query: QueryFn) => Promise<R>): Promise<R> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await fn((text, values) => client.query(text, values));
			await client.query("COMMIT");
			return result;
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}
	}

	// ── Repo ────────────────────────────────────────────────────

	async hasRepo(repoId: string): Promise<boolean> {
		const { rows } = await this.pool.query(SQL.repoExists, [repoId]);
		return rows.length > 0;
	}

	async insertRepo(repoId: string): Promise<void> {
		await this.pool.query(SQL.repoInsert, [repoId]);
	}

	async deleteRepo(repoId: string): Promise<void> {
		await this.pool.query(SQL.repoDelete, [repoId]);
		await this.pool.query(SQL.objDeleteAll, [repoId]);
		await this.pool.query(SQL.refDeleteAll, [repoId]);
	}

	// ── Objects ─────────────────────────────────────────────────

	async getObject(repoId: string, hash: string): Promise<RawObject | null> {
		const { rows } = await this.pool.query<{ type: string; content: Uint8Array }>(SQL.objRead, [
			repoId,
			hash,
		]);
		const row = rows[0];
		if (!row) return null;
		return { type: row.type as RawObject["type"], content: new Uint8Array(row.content) };
	}

	async putObject(repoId: string, hash: string, type: string, content: Uint8Array): Promise<void> {
		await this.pool.query(SQL.objInsert, [repoId, hash, type, content]);
	}

	async putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): Promise<void> {
		await this.transaction(async (query) => {
			for (const obj of objects) {
				await query(SQL.objInsert, [repoId, obj.hash, obj.type, obj.content]);
			}
		});
	}

	async hasObject(repoId: string, hash: string): Promise<boolean> {
		const { rows } = await this.pool.query(SQL.objExists, [repoId, hash]);
		return rows.length > 0;
	}

	async findObjectsByPrefix(repoId: string, prefix: string): Promise<string[]> {
		const { rows } = await this.pool.query<{ hash: string }>(SQL.objPrefix, [repoId, `${prefix}%`]);
		return rows.map((r) => r.hash);
	}

	async listObjectHashes(repoId: string): Promise<string[]> {
		const { rows } = await this.pool.query<{ hash: string }>(SQL.objListHashes, [repoId]);
		return rows.map((r) => r.hash);
	}

	async deleteObjects(repoId: string, hashes: ReadonlyArray<string>): Promise<number> {
		if (hashes.length === 0) return 0;
		const { rows } = await this.pool.query<{ count: string }>(
			"DELETE FROM git_objects WHERE repo_id = $1 AND hash = ANY($2::text[]) RETURNING hash",
			[repoId, Array.from(hashes)],
		);
		return rows.length;
	}

	// ── Refs ────────────────────────────────────────────────────

	async getRef(repoId: string, name: string): Promise<Ref | null> {
		const { rows } = await this.pool.query<RefRow>(SQL.refRead, [repoId, name]);
		return rowToRef(rows[0] ?? null);
	}

	async putRef(repoId: string, name: string, ref: Ref): Promise<void> {
		if (ref.type === "symbolic") {
			await this.pool.query(SQL.refWrite, [repoId, name, "symbolic", null, ref.target]);
		} else {
			await this.pool.query(SQL.refWrite, [repoId, name, "direct", ref.hash, null]);
		}
	}

	async removeRef(repoId: string, name: string): Promise<void> {
		await this.pool.query(SQL.refDelete, [repoId, name]);
	}

	async listRefs(repoId: string, prefix?: string): Promise<RawRefEntry[]> {
		let rows: RefRow[];
		if (prefix) {
			({ rows } = await this.pool.query<RefRow>(SQL.refList, [repoId, `${prefix}%`]));
		} else {
			({ rows } = await this.pool.query<RefRow>(SQL.refListAll, [repoId]));
		}
		return rows.flatMap((row) => {
			const ref = rowToRef(row);
			return ref ? [{ name: row.name, ref }] : [];
		});
	}

	async atomicRefUpdate<T>(repoId: string, fn: (ops: RefOps) => Promise<T> | T): Promise<T> {
		return this.transaction(async (query) => {
			return fn({
				getRef: async (name) => {
					const { rows } = await query<RefRow>(SQL.refReadForUpdate, [repoId, name]);
					return rowToRef(rows[0] ?? null);
				},
				putRef: async (name, ref) => {
					if (ref.type === "symbolic") {
						await query(SQL.refWrite, [repoId, name, "symbolic", null, ref.target]);
					} else {
						await query(SQL.refWrite, [repoId, name, "direct", ref.hash, null]);
					}
				},
				removeRef: async (name) => {
					await query(SQL.refDelete, [repoId, name]);
				},
			});
		});
	}
}

// ── Shared helpers ──────────────────────────────────────────────────

type QueryFn = <T = any>(text: string, values?: any[]) => Promise<{ rows: T[] }>;

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
