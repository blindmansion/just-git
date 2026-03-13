import { readObject } from "./object-db.ts";
import { parseCommit } from "./objects/commit.ts";
import { join } from "./path.ts";
import type { Commit, GitContext, Identity, ObjectId } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface RebaseTodoEntry {
	/** The original commit hash to replay. */
	hash: ObjectId;
	/** First line of the commit message. */
	subject: string;
}

export interface RebaseState {
	/** Original branch name (e.g. "refs/heads/feature"), or "detached HEAD". */
	headName: string;
	/** Original HEAD hash before the rebase started. */
	origHead: ObjectId;
	/** The commit we are rebasing onto. */
	onto: ObjectId;
	/** Remaining commits to apply (next one first). */
	todo: RebaseTodoEntry[];
	/** Already-applied commits. */
	done: RebaseTodoEntry[];
	/** Current step number (1-based). */
	msgnum: number;
	/** Total number of commits to apply. */
	end: number;
}

// ── Paths ───────────────────────────────────────────────────────────

function rebaseMergeDir(gitCtx: GitContext): string {
	return join(gitCtx.gitDir, "rebase-merge");
}

// ── State read/write ────────────────────────────────────────────────

/**
 * Check whether a rebase is currently in progress.
 */
export async function isRebaseInProgress(gitCtx: GitContext): Promise<boolean> {
	return gitCtx.fs.exists(rebaseMergeDir(gitCtx));
}

/**
 * Read the current rebase state from `.git/rebase-merge/`.
 * Returns null if no rebase is in progress.
 */
export async function readRebaseState(gitCtx: GitContext): Promise<RebaseState | null> {
	const dir = rebaseMergeDir(gitCtx);
	if (!(await gitCtx.fs.exists(dir))) return null;

	const headName = await gitCtx.fs.readFile(join(dir, "head-name"));
	const origHead = await gitCtx.fs.readFile(join(dir, "orig-head"));
	const onto = await gitCtx.fs.readFile(join(dir, "onto"));
	const msgnum = Number.parseInt(await gitCtx.fs.readFile(join(dir, "msgnum")), 10);
	const end = Number.parseInt(await gitCtx.fs.readFile(join(dir, "end")), 10);
	const todoFile = (await gitCtx.fs.exists(join(dir, "git-rebase-todo")))
		? join(dir, "git-rebase-todo")
		: join(dir, "todo");
	const todo = parseTodoList(await gitCtx.fs.readFile(todoFile));
	const doneText = (await gitCtx.fs.exists(join(dir, "done")))
		? await gitCtx.fs.readFile(join(dir, "done"))
		: "";
	const done = parseTodoList(doneText);

	return {
		headName: headName.trim(),
		origHead: origHead.trim(),
		onto: onto.trim(),
		todo,
		done,
		msgnum,
		end,
	};
}

/**
 * Write initial rebase state to `.git/rebase-merge/`.
 */
export async function writeRebaseState(gitCtx: GitContext, state: RebaseState): Promise<void> {
	const dir = rebaseMergeDir(gitCtx);
	await gitCtx.fs.mkdir(dir, { recursive: true });

	await gitCtx.fs.writeFile(join(dir, "head-name"), `${state.headName}\n`);
	await gitCtx.fs.writeFile(join(dir, "orig-head"), `${state.origHead}\n`);
	await gitCtx.fs.writeFile(join(dir, "onto"), `${state.onto}\n`);
	await gitCtx.fs.writeFile(join(dir, "msgnum"), `${String(state.msgnum)}\n`);
	await gitCtx.fs.writeFile(join(dir, "end"), `${String(state.end)}\n`);
	await gitCtx.fs.writeFile(join(dir, "git-rebase-todo"), formatTodoList(state.todo));
	await gitCtx.fs.writeFile(join(dir, "done"), formatTodoList(state.done));
	await gitCtx.fs.writeFile(join(dir, "interactive"), "");
}

/**
 * Update the rebase state after applying one commit:
 * move the head of `todo` into `done`, advance `msgnum`.
 */
export async function advanceRebaseState(gitCtx: GitContext): Promise<void> {
	const dir = rebaseMergeDir(gitCtx);
	const state = await readRebaseState(gitCtx);
	if (!state) throw new Error("No rebase in progress");

	const applied = state.todo.shift();
	if (applied) state.done.push(applied);
	state.msgnum = state.done.length;

	await gitCtx.fs.writeFile(join(dir, "msgnum"), `${String(state.msgnum)}\n`);
	await gitCtx.fs.writeFile(join(dir, "git-rebase-todo"), formatTodoList(state.todo));
	await gitCtx.fs.writeFile(join(dir, "done"), formatTodoList(state.done));
}

/**
 * Remove the rebase state directory entirely.
 */
export async function cleanupRebaseState(gitCtx: GitContext): Promise<void> {
	const dir = rebaseMergeDir(gitCtx);
	if (await gitCtx.fs.exists(dir)) {
		await gitCtx.fs.rm(dir, { recursive: true });
	}
}

/**
 * Write per-step metadata that real git expects during a conflicted rebase:
 * `author-script`, `stopped-sha`. These are needed for cross-tool handoff.
 */
export async function writeRebaseConflictMeta(
	gitCtx: GitContext,
	commitHash: ObjectId,
	author: Identity,
): Promise<void> {
	const dir = rebaseMergeDir(gitCtx);
	const dateStr = `@${author.timestamp} ${author.timezone}`;

	await gitCtx.fs.writeFile(
		join(dir, "author-script"),
		`GIT_AUTHOR_NAME='${author.name}'\nGIT_AUTHOR_EMAIL='${author.email}'\nGIT_AUTHOR_DATE='${dateStr}'\n`,
	);
	await gitCtx.fs.writeFile(join(dir, "stopped-sha"), `${commitHash}\n`);
}

function parseTodoList(text: string): RebaseTodoEntry[] {
	const entries: RebaseTodoEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^pick\s+([0-9a-f]+)\s+(.*)/);
		if (match?.[1] && match[2]) {
			// Real git uses "pick <hash> # <subject>" — strip the "# " prefix
			const subject = match[2].startsWith("# ") ? match[2].slice(2) : match[2];
			entries.push({ hash: match[1], subject });
		}
	}
	return entries;
}

function formatTodoList(entries: RebaseTodoEntry[]): string {
	if (entries.length === 0) return "";
	return `${entries.map((e) => `pick ${e.hash} # ${e.subject}`).join("\n")}\n`;
}

// ── Planner ─────────────────────────────────────────────────────────

interface PlannedCommit {
	hash: ObjectId;
	commit: Commit;
}

interface RebaseSymmetricPlan {
	right: PlannedCommit[];
	left: PlannedCommit[];
}

/**
 * Collect symmetric-difference sides for rebase planning:
 * - right: commits reachable from head but not upstream
 * - left: commits reachable from upstream but not head
 *
 * Ordering is topological oldest-first (parents before children), with
 * merge commits filtered at output time (mirrors rev-list --max-parents=1
 * as an output filter).
 */
export async function collectRebaseSymmetricPlan(
	ctx: GitContext,
	upstream: ObjectId,
	head: ObjectId,
): Promise<RebaseSymmetricPlan> {
	const cache = new Map<ObjectId, PlannedCommit>();
	const [upstreamReachable, headReachable] = await Promise.all([
		collectReachable(ctx, upstream, cache),
		collectReachable(ctx, head, cache),
	]);

	const rightOnly = new Set<ObjectId>();
	for (const hash of headReachable) {
		if (!upstreamReachable.has(hash)) rightOnly.add(hash);
	}

	const leftOnly = new Set<ObjectId>();
	for (const hash of upstreamReachable) {
		if (!headReachable.has(hash)) leftOnly.add(hash);
	}

	return {
		right: await orderNonMergeSideFromStart(ctx, cache, head, rightOnly),
		left: await orderNonMergeSideFromStart(ctx, cache, upstream, leftOnly),
	};
}

async function collectReachable(
	ctx: GitContext,
	start: ObjectId,
	cache: Map<ObjectId, PlannedCommit>,
): Promise<Set<ObjectId>> {
	const seen = new Set<ObjectId>();
	const queue: ObjectId[] = [start];
	let qi = 0;

	while (qi < queue.length) {
		const hash = queue[qi++]!;
		if (seen.has(hash)) continue;
		seen.add(hash);

		const entry = await loadCommit(ctx, hash, cache);
		for (const parent of entry.commit.parents) {
			if (!seen.has(parent)) queue.push(parent);
		}
	}

	return seen;
}

/**
 * Order the commits in `side` topologically (parents before children),
 * outputting only non-merge commits.
 *
 * Matches git's new topo walk (revision.c) used by sequencer_make_script:
 *  - ALL commits (including merges) participate in the topological sort.
 *    Merge commits create ordering constraints: when a merge is popped
 *    from the LIFO queue, its parents are pushed in iteration order,
 *    so the LAST parent is processed first. This determines which
 *    branch of a merge is traversed first.
 *  - max_parents=1 is an OUTPUT filter only — merges are sorted but
 *    not emitted. This is critical: excluding merges from the sort
 *    removes the parent-order constraints they impose.
 *  - REV_SORT_IN_GRAPH_ORDER uses a LIFO stack for DFS-like traversal.
 *  - --reverse flips the output to oldest-first (parents before children).
 */
async function orderNonMergeSideFromStart(
	ctx: GitContext,
	cache: Map<ObjectId, PlannedCommit>,
	_start: ObjectId,
	side: Set<ObjectId>,
): Promise<PlannedCommit[]> {
	if (side.size === 0) return [];

	// Compute indegrees for ALL commits in the side set (including merges).
	const indegree = new Map<ObjectId, number>();
	for (const hash of side) {
		indegree.set(hash, 0);
	}
	for (const hash of side) {
		const entry = await loadCommit(ctx, hash, cache);
		for (const parent of entry.commit.parents) {
			if (side.has(parent)) {
				indegree.set(parent, (indegree.get(parent) ?? 0) + 1);
			}
		}
	}

	// Collect zero-indegree tips. Sort by committer timestamp ascending
	// so that LIFO pops newest-first (matching git's indegree_queue which
	// pops lowest-generation/oldest-date first, pushing to LIFO where the
	// last pushed = highest-gen/newest gets popped first).
	const tips: PlannedCommit[] = [];
	for (const hash of side) {
		if (indegree.get(hash) === 0) {
			tips.push(await loadCommit(ctx, hash, cache));
		}
	}
	tips.sort((a, b) => a.commit.committer.timestamp - b.commit.committer.timestamp);

	const stack: ObjectId[] = tips.map((t) => t.hash);
	const ordered: PlannedCommit[] = [];
	const visited = new Set<ObjectId>();

	while (stack.length > 0) {
		const hash = stack.pop();
		if (!hash || visited.has(hash)) continue;
		visited.add(hash);

		const entry = await loadCommit(ctx, hash, cache);
		// Only emit non-merge commits (max_parents=1 output filter).
		if (entry.commit.parents.length <= 1) {
			ordered.push(entry);
		}

		// Push ALL parents (including those of merges) to maintain
		// ordering constraints. Parent iteration order matters for LIFO:
		// last parent pushed is popped first.
		for (const parent of entry.commit.parents) {
			if (side.has(parent) && !visited.has(parent)) {
				const newDeg = (indegree.get(parent) ?? 0) - 1;
				indegree.set(parent, newDeg);
				if (newDeg <= 0) stack.push(parent);
			}
		}
	}

	ordered.reverse();
	return ordered;
}

async function loadCommit(
	ctx: GitContext,
	hash: ObjectId,
	cache: Map<ObjectId, PlannedCommit>,
): Promise<PlannedCommit> {
	const cached = cache.get(hash);
	if (cached) return cached;

	const raw = await readObject(ctx, hash);
	if (raw.type !== "commit") {
		throw new Error(`Expected commit object, got ${raw.type}`);
	}

	const entry: PlannedCommit = { hash, commit: parseCommit(raw.content) };
	cache.set(hash, entry);
	return entry;
}
