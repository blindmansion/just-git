/**
 * Comparison utilities for checking your in-memory git implementation
 * against stored oracle snapshots.
 *
 * Your implementation should emit state in these shapes after each command.
 *
 * Divergences are classified into two severity levels:
 *
 *   "error" — Functionally different behavior. The worktree, branch,
 *             active operation, or index structure/content differs.
 *             These always indicate a real bug.
 *
 *   "warn"  — Different internal state that doesn't affect user-visible
 *             behavior. Typically caused by different commit ordering
 *             during rebase (equivalent content, different history).
 *             The test continues past warnings.
 */

export interface ImplState {
	headRef: string | null;
	headSha: string | null;
	refs: Map<string, string>; // refName → sha
	/** Index keyed by "path:stage" to handle conflict entries (stages 1/2/3). */
	index: Map<string, { mode: number; sha: string }>; // "path:stage" → {mode, sha}
	/** Deterministic hash of the worktree (same algorithm as capture.hashWorkTree). */
	workTreeHash: string;
	activeOperation: string | null;
	operationStateHash: string | null;
	/** Stash commit hashes in stack order (newest first). */
	stashHashes: string[];
}

export interface OracleState {
	head: { headRef: string | null; headSha: string | null };
	refs: { refName: string; sha: string }[];
	index: { path: string; mode: number; sha: string; stage: number }[];
	operation: { operation: string | null; stateHash: string | null };
	workTreeHash: string;
	/** Stash commit hashes in stack order (newest first). */
	stashHashes: string[];
}

export type DivergenceSeverity = "error" | "warn";

export interface Divergence {
	field: string;
	expected: unknown;
	actual: unknown;
	severity: DivergenceSeverity;
}

// ── Severity classification ──────────────────────────────────────

interface SeverityContext {
	currentBranchRef: string | null;
}

/**
 * Classify a divergence field as error or warning.
 *
 * Errors (functionally different behavior):
 *   - work_tree: different files on disk
 *   - head_ref: on the wrong branch
 *   - active_operation: wrong operation state (rebase vs none, etc.)
 *   - head_sha: wrong commit when HEAD is attached to a branch
 *   - ref:*: checked-out branch moved to the wrong commit, or missing/extra refs
 *   - index:*: any index difference (structure, content, mode)
 *
 * Warnings (different history, equivalent behavior):
 *   - head_sha: detached HEAD points to different commit
 *   - ref:* sha mismatch on non-current refs
 *   - operation_state_hash: internal operation state differs
 */
function classifySeverity(
	field: string,
	expected: unknown,
	actual: unknown,
	context: SeverityContext,
): DivergenceSeverity {
	// Worktree, head_ref, active_operation are always errors
	if (field === "work_tree") return "error";
	if (field === "head_ref") return "error";
	if (field === "active_operation") return "error";

	// When HEAD is attached, a different commit hash means the checked-out
	// branch points somewhere else. Detached HEAD drift remains warning-only
	// for now because some planner-related history differences are still
	// intentionally tolerated elsewhere in the oracle flow.
	if (field === "head_sha") {
		return context.currentBranchRef ? "error" : "warn";
	}

	// operation_state_hash: internal state differs but operation type matches
	// (operation type mismatch is caught separately by active_operation)
	if (field === "operation_state_hash") return "warn";

	// Refs: missing/extra is an error, SHA-only difference is a warning.
	// Exception: refs/remotes/*/HEAD is cosmetic (created by clone, varies
	// across git versions for fetch/pull) — always warning.
	if (field.startsWith("ref:")) {
		if (/^ref:refs\/remotes\/[^/]+\/HEAD$/.test(field)) return "warn";
		if (expected === "<missing>" || actual === "<missing>") return "error";
		if (context.currentBranchRef && field === `ref:${context.currentBranchRef}`) return "error";
		return "warn";
	}

	// All index differences are errors (affect staging and next commit)
	if (field.startsWith("index:")) return "error";

	// Stash differences are errors
	if (field.startsWith("stash:")) return "error";

	return "error";
}

// ── Full comparison ──────────────────────────────────────────────

/**
 * Compare your implementation's state against the oracle snapshot.
 * Returns an empty array if they match, or a list of divergences
 * with severity classification.
 *
 * Worktree is compared by hash only. On mismatch, the caller should
 * replay the trace and use captureWorkTree() on both sides for a
 * detailed file-level diff.
 */
export function compare(oracle: OracleState, impl: ImplState): Divergence[] {
	const divergences: Divergence[] = [];
	const currentBranchRef =
		oracle.head.headRef !== null &&
		oracle.head.headRef === impl.headRef &&
		oracle.head.headRef.startsWith("ref: ")
			? oracle.head.headRef.slice("ref: ".length)
			: null;

	function push(field: string, expected: unknown, actual: unknown) {
		divergences.push({
			field,
			expected,
			actual,
			severity: classifySeverity(field, expected, actual, { currentBranchRef }),
		});
	}

	// HEAD ref (symbolic vs detached)
	if (oracle.head.headRef !== impl.headRef) {
		push("head_ref", oracle.head.headRef, impl.headRef);
	}

	// HEAD sha
	if (oracle.head.headSha !== impl.headSha) {
		push("head_sha", oracle.head.headSha, impl.headSha);
	}

	// Active operation
	if (oracle.operation.operation !== impl.activeOperation) {
		push("active_operation", oracle.operation.operation, impl.activeOperation);
	}

	// Operation state hash
	if (oracle.operation.stateHash !== impl.operationStateHash) {
		push("operation_state_hash", oracle.operation.stateHash, impl.operationStateHash);
	}

	// Refs — compare as sorted sets
	const oracleRefs = new Map<string, string>();
	for (const r of oracle.refs) {
		oracleRefs.set(r.refName, r.sha);
	}

	for (const [name, sha] of oracleRefs) {
		const implSha = impl.refs.get(name);
		if (implSha === undefined) {
			push(`ref:${name}`, sha, "<missing>");
		} else if (implSha !== sha) {
			push(`ref:${name}`, sha, implSha);
		}
	}

	for (const [name, sha] of impl.refs) {
		if (!oracleRefs.has(name)) {
			push(`ref:${name}`, "<missing>", sha);
		}
	}

	// Index — keyed by "path:stage" to handle conflict entries
	const oracleIndex = new Map<string, { mode: number; sha: string }>();
	for (const e of oracle.index) {
		oracleIndex.set(`${e.path}:${e.stage}`, { mode: e.mode, sha: e.sha });
	}
	const implIndex = impl.index;

	for (const [key, entry] of oracleIndex) {
		const implEntry = implIndex.get(key);
		if (implEntry === undefined) {
			push(`index:${key}`, `${entry.mode.toString(8)} ${entry.sha}`, "<missing>");
		} else {
			if (implEntry.mode !== entry.mode) {
				push(`index:${key}:mode`, entry.mode.toString(8), implEntry.mode.toString(8));
			}
			if (implEntry.sha !== entry.sha) {
				push(`index:${key}:sha`, entry.sha, implEntry.sha);
			}
		}
	}

	for (const [key, entry] of implIndex) {
		if (!oracleIndex.has(key)) {
			push(`index:${key}`, "<missing>", `${entry.mode.toString(8)} ${entry.sha}`);
		}
	}

	// Working tree — hash comparison only.
	// On mismatch, caller should replay + captureWorkTree() for file-level diff.
	if (oracle.workTreeHash !== impl.workTreeHash) {
		push("work_tree", oracle.workTreeHash, impl.workTreeHash);
	}

	// Stash — compare ordered list of commit hashes
	const oracleStash = oracle.stashHashes;
	const implStash = impl.stashHashes;
	if (oracleStash.length !== implStash.length) {
		push("stash:count", oracleStash.length, implStash.length);
	} else {
		for (let i = 0; i < oracleStash.length; i++) {
			if (oracleStash[i] !== implStash[i]) {
				push(`stash:entry:${i}`, oracleStash[i], implStash[i]);
			}
		}
	}

	return divergences;
}

// ── Severity helpers ─────────────────────────────────────────────

/**
 * Normalize a rebase state field for cross-implementation comparison.
 * MERGE_MSG is reduced to first line only (real git may append extra
 * context lines that the virtual impl omits).
 */
export function normalizeRebaseField(name: string, content: string | null): string | null {
	if (content === null) return null;
	if (name === "MERGE_MSG") {
		const firstLine = content.split("\n")[0] ?? "";
		return firstLine.trim();
	}
	return content.trim();
}

/** Check whether a divergence list contains any error-severity items. */
export function hasErrors(divergences: Divergence[]): boolean {
	return divergences.some((d) => d.severity === "error");
}

// ── Fast check ───────────────────────────────────────────────────

/**
 * Quick check — returns true only when state matches EXACTLY (no
 * divergences of any severity). For the common case (no divergence)
 * this avoids the cost of building the full divergence list.
 *
 * When this returns false, the caller should use compare() to get
 * the detailed divergence list with severity classification.
 */
export function matches(oracle: OracleState, impl: ImplState): boolean {
	if (oracle.head.headRef !== impl.headRef) return false;
	if (oracle.head.headSha !== impl.headSha) return false;
	if (oracle.operation.operation !== impl.activeOperation) return false;
	if (oracle.operation.stateHash !== impl.operationStateHash) return false;
	if (oracle.workTreeHash !== impl.workTreeHash) return false;

	// Refs
	if (oracle.refs.length !== impl.refs.size) return false;
	for (const { refName, sha } of oracle.refs) {
		if (impl.refs.get(refName) !== sha) return false;
	}

	// Index with stage-aware keys
	if (oracle.index.length !== impl.index.size) return false;
	for (const { path, stage, mode, sha } of oracle.index) {
		const e = impl.index.get(`${path}:${stage}`);
		if (!e || e.mode !== mode || e.sha !== sha) return false;
	}

	// Stash
	if (oracle.stashHashes.length !== impl.stashHashes.length) return false;
	for (let i = 0; i < oracle.stashHashes.length; i++) {
		if (oracle.stashHashes[i] !== impl.stashHashes[i]) return false;
	}

	return true;
}
