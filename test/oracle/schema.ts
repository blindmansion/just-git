import { Database } from "bun:sqlite";

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
      UNIQUE(trace_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_steps_trace ON steps(trace_id, seq);
  `);

	return db;
}
