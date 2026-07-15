import type { Ref } from "../lib/types.ts";
import type {
	DeltaObjectRow,
	ObjectRow,
	RawRefEntry,
	RefOps,
	RefRow,
	StoredObject,
} from "./repo-store.ts";
import type { RepoPool } from "./repo-pool.ts";
import type { RepoStorage } from "./repo-storage.ts";

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
  repo_id   TEXT NOT NULL,
  hash      TEXT NOT NULL,
  type      TEXT NOT NULL,
  content   BYTEA NOT NULL,
  encoding  TEXT NOT NULL DEFAULT 'raw',
  base_hash TEXT,
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

CREATE TABLE IF NOT EXISTS git_forks (
  repo_id   TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL
);
`;

// ── SQL queries ─────────────────────────────────────────────────────

const SQL = {
	repoInsert: "INSERT INTO git_repos (id) VALUES ($1)",
	repoExists: "SELECT 1 FROM git_repos WHERE id = $1 LIMIT 1",
	repoDelete: "DELETE FROM git_repos WHERE id = $1",

	objInsert:
		"INSERT INTO git_objects (repo_id, hash, type, content) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING hash",
	objRead:
		"SELECT type, content, encoding, base_hash FROM git_objects WHERE repo_id = $1 AND hash = $2",
	objReadMany:
		"SELECT hash, type, content, encoding, base_hash FROM git_objects WHERE repo_id = $1 AND hash = ANY($2::text[])",
	objExists: "SELECT 1 FROM git_objects WHERE repo_id = $1 AND hash = $2 LIMIT 1",
	objExistsMany: "SELECT hash FROM git_objects WHERE repo_id = $1 AND hash = ANY($2::text[])",
	objPrefix: "SELECT hash FROM git_objects WHERE repo_id = $1 AND hash LIKE $2",
	objDeleteAll: "DELETE FROM git_objects WHERE repo_id = $1",
	objListHashes: "SELECT hash FROM git_objects WHERE repo_id = $1",
	objByteSize:
		"SELECT COALESCE(SUM(LENGTH(content)), 0) AS size FROM git_objects WHERE repo_id = $1",

	refRead: "SELECT type, hash, target FROM git_refs WHERE repo_id = $1 AND name = $2",
	refReadForUpdate:
		"SELECT type, hash, target FROM git_refs WHERE repo_id = $1 AND name = $2 FOR UPDATE",
	refWrite: `INSERT INTO git_refs (repo_id, name, type, hash, target) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (repo_id, name) DO UPDATE SET type = EXCLUDED.type, hash = EXCLUDED.hash, target = EXCLUDED.target`,
	refDelete: "DELETE FROM git_refs WHERE repo_id = $1 AND name = $2",
	refList: "SELECT name, type, hash, target FROM git_refs WHERE repo_id = $1 AND name LIKE $2",
	refListAll: "SELECT name, type, hash, target FROM git_refs WHERE repo_id = $1",
	refDeleteAll: "DELETE FROM git_refs WHERE repo_id = $1",

	forkInsert: "INSERT INTO git_forks (repo_id, parent_id) VALUES ($1, $2)",
	forkGetParent: "SELECT parent_id FROM git_forks WHERE repo_id = $1",
	forkListChildren: "SELECT repo_id FROM git_forks WHERE parent_id = $1",
	forkDelete: "DELETE FROM git_forks WHERE repo_id = $1",
} as const;

const OBJECT_INSERT_BATCH_SIZE = 256;

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
export class PgStorage implements RepoPool {
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

	async createRepo(repoId: string): Promise<void> {
		await this.pool.query(SQL.repoInsert, [repoId]);
	}

	async deleteRepo(repoId: string): Promise<void> {
		await this.pool.query(SQL.repoDelete, [repoId]);
		await this.pool.query(SQL.objDeleteAll, [repoId]);
		await this.pool.query(SQL.refDeleteAll, [repoId]);
		await this.pool.query(SQL.forkDelete, [repoId]);
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
			atomicRefUpdate: (fn) => this.atomicRefUpdate(repoId, fn),
		};
	}

	// ── Objects ─────────────────────────────────────────────────

	private async getObject(repoId: string, hash: string): Promise<StoredObject | null> {
		const { rows } = await this.pool.query<ObjectRow>(SQL.objRead, [repoId, hash]);
		return rowToStored(rows[0] ?? null);
	}

	private async getObjects(
		repoId: string,
		hashes: ReadonlyArray<string>,
	): Promise<Map<string, StoredObject>> {
		if (hashes.length === 0) return new Map();
		const { rows } = await this.pool.query<ObjectRow>(SQL.objReadMany, [
			repoId,
			Array.from(new Set(hashes)),
		]);
		const result = new Map<string, StoredObject>();
		for (const row of rows) {
			const stored = rowToStored(row);
			if (stored) result.set(row.hash!, stored);
		}
		return result;
	}

	private async putObject(
		repoId: string,
		hash: string,
		type: string,
		content: Uint8Array,
	): Promise<void> {
		await this.pool.query(SQL.objInsert, [repoId, hash, type, content]);
	}

	private async putObjects(
		repoId: string,
		objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
	): Promise<string[]> {
		if (objects.length === 0) return [];
		return await this.transaction(async (query) => {
			const inserted: string[] = [];
			for (const batch of chunkArray(objects, OBJECT_INSERT_BATCH_SIZE)) {
				const { text, values } = buildBulkObjectInsert(repoId, batch);
				const { rows } = await query<{ hash: string }>(text, values);
				for (const row of rows) {
					inserted.push(row.hash);
				}
			}
			return inserted;
		});
	}

	private async putDeltaObjects(
		repoId: string,
		rows: ReadonlyArray<DeltaObjectRow>,
	): Promise<void> {
		if (rows.length === 0) return;
		await this.transaction(async (query) => {
			for (const batch of chunkArray(rows, OBJECT_INSERT_BATCH_SIZE)) {
				const { text, values } = buildBulkDeltaUpsert(repoId, batch);
				await query(text, values);
			}
		});
	}

	private async hasObject(repoId: string, hash: string): Promise<boolean> {
		const { rows } = await this.pool.query(SQL.objExists, [repoId, hash]);
		return rows.length > 0;
	}

	private async hasObjects(repoId: string, hashes: ReadonlyArray<string>): Promise<Set<string>> {
		if (hashes.length === 0) return new Set();
		const { rows } = await this.pool.query<{ hash: string }>(SQL.objExistsMany, [
			repoId,
			Array.from(new Set(hashes)),
		]);
		return new Set(rows.map((row) => row.hash));
	}

	private async findObjectsByPrefix(repoId: string, prefix: string): Promise<string[]> {
		const { rows } = await this.pool.query<{ hash: string }>(SQL.objPrefix, [repoId, `${prefix}%`]);
		return rows.map((r) => r.hash);
	}

	private async listObjectHashes(repoId: string): Promise<string[]> {
		const { rows } = await this.pool.query<{ hash: string }>(SQL.objListHashes, [repoId]);
		return rows.map((r) => r.hash);
	}

	private async repoByteSize(repoId: string): Promise<number> {
		const { rows } = await this.pool.query<{ size: string | number }>(SQL.objByteSize, [repoId]);
		return rows[0] ? Number(rows[0].size) : 0;
	}

	private async deleteObjects(repoId: string, hashes: ReadonlyArray<string>): Promise<number> {
		if (hashes.length === 0) return 0;
		const { rows } = await this.pool.query<{ count: string }>(
			"DELETE FROM git_objects WHERE repo_id = $1 AND hash = ANY($2::text[]) RETURNING hash",
			[repoId, Array.from(hashes)],
		);
		return rows.length;
	}

	// ── Refs ────────────────────────────────────────────────────

	private async getRef(repoId: string, name: string): Promise<Ref | null> {
		const { rows } = await this.pool.query<RefRow>(SQL.refRead, [repoId, name]);
		return rowToRef(rows[0] ?? null);
	}

	private async putRef(repoId: string, name: string, ref: Ref): Promise<void> {
		if (ref.type === "symbolic") {
			await this.pool.query(SQL.refWrite, [repoId, name, "symbolic", null, ref.target]);
		} else {
			await this.pool.query(SQL.refWrite, [repoId, name, "direct", ref.hash, null]);
		}
	}

	private async removeRef(repoId: string, name: string): Promise<void> {
		await this.pool.query(SQL.refDelete, [repoId, name]);
	}

	private async listRefs(repoId: string, prefix?: string): Promise<RawRefEntry[]> {
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

	private async atomicRefUpdate<T>(
		repoId: string,
		fn: (ops: RefOps) => Promise<T> | T,
	): Promise<T> {
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

	// ── Forks ───────────────────────────────────────────────────

	async fork(sourceId: string, targetId: string): Promise<void> {
		await this.pool.query(SQL.forkInsert, [targetId, sourceId]);
	}

	async parentOf(repoId: string): Promise<string | null> {
		const { rows } = await this.pool.query<{ parent_id: string }>(SQL.forkGetParent, [repoId]);
		return rows[0]?.parent_id ?? null;
	}

	async forksOf(repoId: string): Promise<string[]> {
		const { rows } = await this.pool.query<{ repo_id: string }>(SQL.forkListChildren, [repoId]);
		return rows.map((r) => r.repo_id);
	}
}

// ── Shared helpers ──────────────────────────────────────────────────

type QueryFn = <T = any>(text: string, values?: any[]) => Promise<{ rows: T[] }>;

function rowToStored(row: ObjectRow | null): StoredObject | null {
	if (!row) return null;
	return {
		type: row.type as StoredObject["type"],
		encoding: row.encoding as StoredObject["encoding"],
		baseHash: row.base_hash,
		content: new Uint8Array(row.content),
	};
}

function buildBulkDeltaUpsert(
	repoId: string,
	rows: ReadonlyArray<DeltaObjectRow>,
): { text: string; values: any[] } {
	const values: any[] = [];
	const tuples: string[] = [];

	for (let i = 0; i < rows.length; i++) {
		const base = i * 6;
		const row = rows[i]!;
		const baseHash = "baseHash" in row ? row.baseHash : null;
		values.push(repoId, row.hash, row.type, row.content, row.encoding, baseHash);
		tuples.push(
			`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
		);
	}

	return {
		text: `INSERT INTO git_objects (repo_id, hash, type, content, encoding, base_hash) VALUES ${tuples.join(", ")}
			ON CONFLICT (repo_id, hash) DO UPDATE SET type = EXCLUDED.type, content = EXCLUDED.content, encoding = EXCLUDED.encoding, base_hash = EXCLUDED.base_hash`,
		values,
	};
}

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

function buildBulkObjectInsert(
	repoId: string,
	objects: ReadonlyArray<{ hash: string; type: string; content: Uint8Array }>,
): { text: string; values: any[] } {
	const values: any[] = [];
	const tuples: string[] = [];

	for (let i = 0; i < objects.length; i++) {
		const base = i * 4;
		const obj = objects[i]!;
		values.push(repoId, obj.hash, obj.type, obj.content);
		tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
	}

	return {
		text: `INSERT INTO git_objects (repo_id, hash, type, content) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING RETURNING hash`,
		values,
	};
}

function chunkArray<T>(items: ReadonlyArray<T>, size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}
