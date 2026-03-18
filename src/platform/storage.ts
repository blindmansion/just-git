import type { Database, Statement } from "bun:sqlite";
import type {
	CreatePullRequestOptions,
	ListPullRequestsFilter,
	MergeStrategy,
	PRState,
	PullRequest,
	Repo,
	UpdatePullRequestOptions,
} from "./types.ts";

// ── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS platform_repos (
  id TEXT PRIMARY KEY,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_pull_requests (
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_ref TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_sha TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open'
    CHECK(state IN ('open', 'closed', 'merged')),
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  merged_at TEXT,
  merge_commit_sha TEXT,
  merge_strategy TEXT,
  PRIMARY KEY (repo_id, number)
);
`;

// ── Prepared statements ─────────────────────────────────────────────

interface Statements {
	repoInsert: Statement;
	repoGet: Statement;
	repoList: Statement;
	repoDelete: Statement;

	prInsert: Statement;
	prGet: Statement;
	prListAll: Statement;
	prListByState: Statement;
	prNextNumber: Statement;
	prUpdate: Statement;
	prSetState: Statement;
	prSetMerged: Statement;
	prUpdateHead: Statement;
	prOpenByHeadRef: Statement;
	prDeleteByRepo: Statement;
}

function prepareStatements(db: Database): Statements {
	return {
		repoInsert: db.prepare("INSERT INTO platform_repos (id, default_branch) VALUES (?, ?)"),
		repoGet: db.prepare("SELECT id, default_branch, created_at FROM platform_repos WHERE id = ?"),
		repoList: db.prepare(
			"SELECT id, default_branch, created_at FROM platform_repos ORDER BY created_at",
		),
		repoDelete: db.prepare("DELETE FROM platform_repos WHERE id = ?"),

		prInsert: db.prepare(
			`INSERT INTO platform_pull_requests
			 (repo_id, number, head_ref, base_ref, head_sha, title, body, author_name, author_email)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		),
		prGet: db.prepare(
			`SELECT repo_id, number, head_ref, base_ref, head_sha, title, body, state,
			        author_name, author_email, created_at, updated_at,
			        merged_at, merge_commit_sha, merge_strategy
			 FROM platform_pull_requests
			 WHERE repo_id = ? AND number = ?`,
		),
		prListAll: db.prepare(
			`SELECT repo_id, number, head_ref, base_ref, head_sha, title, body, state,
			        author_name, author_email, created_at, updated_at,
			        merged_at, merge_commit_sha, merge_strategy
			 FROM platform_pull_requests
			 WHERE repo_id = ?
			 ORDER BY number`,
		),
		prListByState: db.prepare(
			`SELECT repo_id, number, head_ref, base_ref, head_sha, title, body, state,
			        author_name, author_email, created_at, updated_at,
			        merged_at, merge_commit_sha, merge_strategy
			 FROM platform_pull_requests
			 WHERE repo_id = ? AND state = ?
			 ORDER BY number`,
		),
		prNextNumber: db.prepare(
			"SELECT COALESCE(MAX(number), 0) + 1 AS next FROM platform_pull_requests WHERE repo_id = ?",
		),
		prUpdate: db.prepare(
			`UPDATE platform_pull_requests
			 SET title = COALESCE(?, title),
			     body = COALESCE(?, body),
			     updated_at = datetime('now')
			 WHERE repo_id = ? AND number = ?`,
		),
		prSetState: db.prepare(
			`UPDATE platform_pull_requests
			 SET state = ?, updated_at = datetime('now')
			 WHERE repo_id = ? AND number = ?`,
		),
		prSetMerged: db.prepare(
			`UPDATE platform_pull_requests
			 SET state = 'merged',
			     merged_at = datetime('now'),
			     merge_commit_sha = ?,
			     merge_strategy = ?,
			     updated_at = datetime('now')
			 WHERE repo_id = ? AND number = ?`,
		),
		prUpdateHead: db.prepare(
			`UPDATE platform_pull_requests
			 SET head_sha = ?, updated_at = datetime('now')
			 WHERE repo_id = ? AND number = ?`,
		),
		prOpenByHeadRef: db.prepare(
			`SELECT repo_id, number, head_ref, base_ref, head_sha, title, body, state,
			        author_name, author_email, created_at, updated_at,
			        merged_at, merge_commit_sha, merge_strategy
			 FROM platform_pull_requests
			 WHERE repo_id = ? AND head_ref = ? AND state = 'open'`,
		),
		prDeleteByRepo: db.prepare("DELETE FROM platform_pull_requests WHERE repo_id = ?"),
	};
}

// ── Row → domain model mappers ──────────────────────────────────────

interface RepoRow {
	id: string;
	default_branch: string;
	created_at: string;
}

interface PRRow {
	repo_id: string;
	number: number;
	head_ref: string;
	base_ref: string;
	head_sha: string | null;
	title: string;
	body: string;
	state: string;
	author_name: string;
	author_email: string;
	created_at: string;
	updated_at: string;
	merged_at: string | null;
	merge_commit_sha: string | null;
	merge_strategy: string | null;
}

function toRepo(row: RepoRow): Repo {
	return {
		id: row.id,
		defaultBranch: row.default_branch,
		createdAt: row.created_at,
	};
}

function toPullRequest(row: PRRow): PullRequest {
	return {
		repoId: row.repo_id,
		number: row.number,
		headRef: row.head_ref,
		baseRef: row.base_ref,
		headSha: row.head_sha,
		title: row.title,
		body: row.body,
		state: row.state as PRState,
		authorName: row.author_name,
		authorEmail: row.author_email,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		mergedAt: row.merged_at,
		mergeCommitSha: row.merge_commit_sha,
		mergeStrategy: row.merge_strategy as MergeStrategy | null,
	};
}

// ── PlatformDb ──────────────────────────────────────────────────────

export class PlatformDb {
	private stmts: Statements;

	constructor(private db: Database) {
		db.exec(SCHEMA);
		this.stmts = prepareStatements(db);
	}

	// ── Repos ─────────────────────────────────────────────────────

	createRepo(id: string, defaultBranch = "main"): Repo {
		this.stmts.repoInsert.run(id, defaultBranch);
		return this.getRepo(id)!;
	}

	getRepo(id: string): Repo | null {
		const row = this.stmts.repoGet.get(id) as RepoRow | null;
		return row ? toRepo(row) : null;
	}

	listRepos(): Repo[] {
		return (this.stmts.repoList.all() as RepoRow[]).map(toRepo);
	}

	deleteRepo(id: string): void {
		this.stmts.prDeleteByRepo.run(id);
		this.stmts.repoDelete.run(id);
	}

	// ── Pull Requests ─────────────────────────────────────────────

	createPullRequest(
		repoId: string,
		opts: CreatePullRequestOptions,
		headSha: string | null,
	): PullRequest {
		const { next } = this.stmts.prNextNumber.get(repoId) as { next: number };
		this.stmts.prInsert.run(
			repoId,
			next,
			opts.head,
			opts.base,
			headSha,
			opts.title,
			opts.body ?? "",
			opts.author.name,
			opts.author.email,
		);
		return this.getPullRequest(repoId, next)!;
	}

	getPullRequest(repoId: string, number: number): PullRequest | null {
		const row = this.stmts.prGet.get(repoId, number) as PRRow | null;
		return row ? toPullRequest(row) : null;
	}

	listPullRequests(repoId: string, filter?: ListPullRequestsFilter): PullRequest[] {
		if (filter?.state) {
			return (this.stmts.prListByState.all(repoId, filter.state) as PRRow[]).map(toPullRequest);
		}
		return (this.stmts.prListAll.all(repoId) as PRRow[]).map(toPullRequest);
	}

	updatePullRequest(repoId: string, number: number, opts: UpdatePullRequestOptions): void {
		this.stmts.prUpdate.run(opts.title ?? null, opts.body ?? null, repoId, number);
	}

	closePullRequest(repoId: string, number: number): void {
		this.stmts.prSetState.run("closed", repoId, number);
	}

	markMerged(repoId: string, number: number, commitSha: string, strategy: MergeStrategy): void {
		this.stmts.prSetMerged.run(commitSha, strategy, repoId, number);
	}

	updateHeadSha(repoId: string, number: number, sha: string): void {
		this.stmts.prUpdateHead.run(sha, repoId, number);
	}

	findOpenPRsByHeadRef(repoId: string, headRef: string): PullRequest[] {
		return (this.stmts.prOpenByHeadRef.all(repoId, headRef) as PRRow[]).map(toPullRequest);
	}
}
