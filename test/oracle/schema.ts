import { Database } from "bun:sqlite";

/**
 * Bump on any change to the stored snapshot shape OR the steps-row shape.
 *
 * We deliberately do not build a migration framework: oracle traces are cheap
 * to regenerate (`bun oracle generate <name> …`), isolated per-file under
 * `data/<name>/traces.sqlite`, and gitignored. The correct "migration" is
 * `rm` + regenerate. This version is a *guard*, not a migrator — it refuses to
 * read data the current code can't interpret, rather than transforming it.
 *
 * Because snapshots are delta-encoded and parsed opaquely, a stale on-disk DB
 * would otherwise decode old-shape deltas through new compare code and produce
 * silent miscompares (spurious passes/divergences). The guard turns that into
 * a loud "regenerate" error instead.
 *
 * History:
 *   1 — original singleton snapshot (head/index/operation/workTreeHash + thin
 *       per-worktree HEADs).
 *   2 — per-worktree snapshot (each worktree carries its own index, worktree
 *       hash, operation, lock, prunable, and existence state).
 *   3 — per-step execution context: `steps.cwd` records the worktree a command
 *       and its file ops ran inside (NULL = the primary worktree). Additive and
 *       nullable, but bumped to keep the one-version-per-shape-change rule.
 *   4 — per-worktree `path` is now the anchor-relative normalized checkout path
 *       (was an absolute, side-specific path) and is the *comparison key* for
 *       linked worktrees, replacing the admin-dir id (Tier 3). The field's
 *       meaning changed and it is now compared, so the snapshot shape changed.
 */
export const SCHEMA_VERSION = 4;

/** Read `PRAGMA user_version`. Pre-versioning DBs report 0. */
function readUserVersion(db: Database): number {
	const row = db.query("PRAGMA user_version").get() as { user_version: number };
	return row.user_version;
}

/**
 * Throw unless the DB's `user_version` matches the code's `SCHEMA_VERSION`.
 * Use on any path that *reads* stored snapshots from a DB the current process
 * did not create (the replay/test/inspect paths open the DB directly).
 */
export function assertSchemaVersion(db: Database): void {
	const v = readUserVersion(db);
	if (v !== SCHEMA_VERSION) {
		throw new Error(
			`Trace DB schema v${v} != code v${SCHEMA_VERSION}. ` +
				`Regenerate: bun oracle generate <name> --seeds <spec>`,
		);
	}
}

export function initDb(path: string): Database {
	const db = new Database(path);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA synchronous = NORMAL");
	db.run("PRAGMA foreign_keys = ON");

	db.run(`
    CREATE TABLE IF NOT EXISTS traces (
      trace_id INTEGER PRIMARY KEY AUTOINCREMENT,
      seed INTEGER NOT NULL,
      description TEXT,
      config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS steps (
      step_id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id INTEGER NOT NULL REFERENCES traces(trace_id),
      seq INTEGER NOT NULL,
      command TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      stdout TEXT,
      stderr TEXT,
      snapshot TEXT NOT NULL,
      cwd TEXT,
      UNIQUE(trace_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_steps_trace ON steps(trace_id, seq);
  `);

	// Stamp a freshly created DB; verify an existing one. A brand-new DB has
	// user_version 0 and no recorded traces; an old pre-versioning DB (also 0)
	// has traces — that's the stale case the guard must reject.
	const version = readUserVersion(db);
	const traceCount = (db.query("SELECT COUNT(*) AS n FROM traces").get() as { n: number }).n;
	if (version === 0 && traceCount === 0) {
		db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	} else {
		assertSchemaVersion(db);
	}

	return db;
}
