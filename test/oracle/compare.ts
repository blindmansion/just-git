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
 *
 * State is modelled per worktree: the main worktree (`id: "main"`) plus each
 * linked worktree. Refs and the stash are shared (common-dir) state, compared
 * once. The main worktree's divergence fields keep their legacy unprefixed
 * names (`head_ref`, `work_tree`, `index:…`, …) so the post-mortem and
 * severity machinery that keys on them keeps working; linked worktrees use a
 * `worktree:<id>:` prefix so the debug CLIs can point at a specific checkout.
 */

// ── State shapes ─────────────────────────────────────────────────

interface OracleIndexEntry {
	path: string;
	mode: number;
	sha: string;
	stage: number;
}

/** A single worktree's state, oracle (stored) form. */
export interface OracleWorktreeState {
	id: string;
	path: string;
	headRef: string | null;
	headSha: string | null;
	index: OracleIndexEntry[];
	workTreeHash: string;
	operation: string | null;
	operationStateHash: string | null;
	locked: boolean;
	lockReason: string | null;
	prunable: string | null;
	checkoutExists: boolean;
}

/** A single worktree's state, impl (live) form — index keyed for fast lookup. */
export interface ImplWorktreeState {
	id: string;
	path: string;
	headRef: string | null;
	headSha: string | null;
	/** Index keyed by "path:stage" to handle conflict entries (stages 1/2/3). */
	index: Map<string, { mode: number; sha: string }>;
	workTreeHash: string;
	operation: string | null;
	operationStateHash: string | null;
	locked: boolean;
	lockReason: string | null;
	prunable: string | null;
	checkoutExists: boolean;
}

export interface OracleState {
	/** Shared (common-dir) refs. */
	refs: { refName: string; sha: string }[];
	/** Shared stash commit hashes in stack order (newest first). */
	stashHashes: string[];
	/** Every worktree's state — the main worktree first. */
	worktrees: OracleWorktreeState[];
}

export interface ImplState {
	refs: Map<string, string>; // refName → sha
	stashHashes: string[];
	worktrees: ImplWorktreeState[];
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
 * Classify a *shared* divergence field (refs, stash) as error or warning.
 *
 *   - ref:    checked-out branch moved to the wrong commit, or a missing/extra
 *             ref, are errors; other sha drift is a warning. A remote HEAD ref
 *             is cosmetic (always a warning).
 *   - stash:  any difference is an error.
 */
function classifySeverity(
	field: string,
	expected: unknown,
	actual: unknown,
	context: SeverityContext,
): DivergenceSeverity {
	// Refs: missing/extra is an error, SHA-only difference is a warning.
	// Exception: refs/remotes/*/HEAD is cosmetic (created by clone, varies
	// across git versions for fetch/pull) — always warning.
	if (field.startsWith("ref:")) {
		if (/^ref:refs\/remotes\/[^/]+\/HEAD$/.test(field)) return "warn";
		if (expected === "<missing>" || actual === "<missing>") return "error";
		if (context.currentBranchRef && field === `ref:${context.currentBranchRef}`) return "error";
		return "warn";
	}

	// Stash differences are errors
	if (field.startsWith("stash:")) return "error";

	return "error";
}

/**
 * Severity for a per-worktree field, given whether that worktree is attached
 * to a branch. Mirrors the historical singleton rules, evaluated per worktree:
 *   - work_tree / head_ref / active_operation / index — always error
 *   - head_sha — error when attached, warn when detached
 *   - operation_state_hash / lock_reason — warn (internal/cosmetic detail)
 *   - locked / prunable / checkout_exists — error (real behavioural state)
 */
function worktreeFieldSeverity(baseField: string, onBranch: boolean): DivergenceSeverity {
	if (baseField === "head_sha") return onBranch ? "error" : "warn";
	if (baseField === "operation_state_hash") return "warn";
	if (baseField === "lock_reason") return "warn";
	return "error";
}

// ── Per-worktree comparison ──────────────────────────────────────

type Push = (
	field: string,
	expected: unknown,
	actual: unknown,
	severity: DivergenceSeverity,
) => void;

/**
 * Compare a single worktree's oracle vs impl state, pushing divergences with
 * the given field `prefix` ("" for the main worktree, `worktree:<id>:` for a
 * linked one). Shared by both `compare()` and `matches()` so the two never
 * drift out of lockstep.
 */
function compareWorktree(
	oracle: OracleWorktreeState,
	impl: ImplWorktreeState,
	prefix: string,
	push: Push,
): void {
	const onBranch =
		oracle.headRef !== null &&
		oracle.headRef === impl.headRef &&
		oracle.headRef.startsWith("ref: ");
	const sev = (base: string) => worktreeFieldSeverity(base, onBranch);
	const f = (base: string) => `${prefix}${base}`;

	// HEAD ref (symbolic vs detached) + sha
	if (oracle.headRef !== impl.headRef) {
		push(f("head_ref"), oracle.headRef, impl.headRef, sev("head_ref"));
	}
	if (oracle.headSha !== impl.headSha) {
		push(f("head_sha"), oracle.headSha, impl.headSha, sev("head_sha"));
	}

	// Active operation + internal operation state hash
	if (oracle.operation !== impl.operation) {
		push(f("active_operation"), oracle.operation, impl.operation, sev("active_operation"));
	}
	if (oracle.operationStateHash !== impl.operationStateHash) {
		push(
			f("operation_state_hash"),
			oracle.operationStateHash,
			impl.operationStateHash,
			sev("operation_state_hash"),
		);
	}

	// Working tree — hash comparison only. On mismatch, the caller should
	// replay + captureWorkTree() for a file-level diff.
	if (oracle.workTreeHash !== impl.workTreeHash) {
		push(f("work_tree"), oracle.workTreeHash, impl.workTreeHash, sev("work_tree"));
	}

	// Index — keyed by "path:stage" to handle conflict entries
	const oracleIndex = new Map<string, { mode: number; sha: string }>();
	for (const e of oracle.index) {
		oracleIndex.set(`${e.path}:${e.stage}`, { mode: e.mode, sha: e.sha });
	}
	for (const [key, entry] of oracleIndex) {
		const implEntry = impl.index.get(key);
		if (implEntry === undefined) {
			push(f(`index:${key}`), `${entry.mode.toString(8)} ${entry.sha}`, "<missing>", "error");
		} else {
			if (implEntry.mode !== entry.mode) {
				push(f(`index:${key}:mode`), entry.mode.toString(8), implEntry.mode.toString(8), "error");
			}
			if (implEntry.sha !== entry.sha) {
				push(f(`index:${key}:sha`), entry.sha, implEntry.sha, "error");
			}
		}
	}
	for (const [key, entry] of impl.index) {
		if (!oracleIndex.has(key)) {
			push(f(`index:${key}`), "<missing>", `${entry.mode.toString(8)} ${entry.sha}`, "error");
		}
	}

	// Lock / prunable / existence state
	if (oracle.locked !== impl.locked) {
		push(f("locked"), oracle.locked, impl.locked, sev("locked"));
	}
	if ((oracle.lockReason ?? null) !== (impl.lockReason ?? null)) {
		push(f("lock_reason"), oracle.lockReason, impl.lockReason, sev("lock_reason"));
	}
	// Compare prunable by presence only — the reason wording differs between
	// real git's porcelain and our worktree-admin descriptions.
	if ((oracle.prunable === null) !== (impl.prunable === null)) {
		push(f("prunable"), oracle.prunable, impl.prunable, sev("prunable"));
	}
	if (oracle.checkoutExists !== impl.checkoutExists) {
		push(f("checkout_exists"), oracle.checkoutExists, impl.checkoutExists, sev("checkout_exists"));
	}
}

// ── Full comparison ──────────────────────────────────────────────

/**
 * Compare your implementation's state against the oracle snapshot.
 * Returns an empty array if they match, or a list of divergences
 * with severity classification.
 */
export function compare(oracle: OracleState, impl: ImplState): Divergence[] {
	const divergences: Divergence[] = [];

	const mainOracle = oracle.worktrees.find((w) => w.id === "main");
	const mainImpl = impl.worktrees.find((w) => w.id === "main");
	const currentBranchRef =
		mainOracle &&
		mainImpl &&
		mainOracle.headRef !== null &&
		mainOracle.headRef === mainImpl.headRef &&
		mainOracle.headRef.startsWith("ref: ")
			? mainOracle.headRef.slice("ref: ".length)
			: null;

	const pushShared = (field: string, expected: unknown, actual: unknown) => {
		divergences.push({
			field,
			expected,
			actual,
			severity: classifySeverity(field, expected, actual, { currentBranchRef }),
		});
	};
	const push: Push = (field, expected, actual, severity) => {
		divergences.push({ field, expected, actual, severity });
	};

	// Refs — shared, compared as sorted sets
	const oracleRefs = new Map<string, string>();
	for (const r of oracle.refs) {
		oracleRefs.set(r.refName, r.sha);
	}
	for (const [name, sha] of oracleRefs) {
		const implSha = impl.refs.get(name);
		if (implSha === undefined) {
			pushShared(`ref:${name}`, sha, "<missing>");
		} else if (implSha !== sha) {
			pushShared(`ref:${name}`, sha, implSha);
		}
	}
	for (const [name, sha] of impl.refs) {
		if (!oracleRefs.has(name)) {
			pushShared(`ref:${name}`, "<missing>", sha);
		}
	}

	// Stash — shared, compare ordered list of commit hashes
	const oracleStash = oracle.stashHashes;
	const implStash = impl.stashHashes;
	if (oracleStash.length !== implStash.length) {
		pushShared("stash:count", oracleStash.length, implStash.length);
	} else {
		for (let i = 0; i < oracleStash.length; i++) {
			if (oracleStash[i] !== implStash[i]) {
				pushShared(`stash:entry:${i}`, oracleStash[i], implStash[i]);
			}
		}
	}

	// Worktrees — main first (unprefixed fields), then linked (prefixed)
	const oracleWt = new Map(oracle.worktrees.map((w) => [w.id, w]));
	const implWt = new Map(impl.worktrees.map((w) => [w.id, w]));
	for (const [id, ow] of oracleWt) {
		const iw = implWt.get(id);
		if (iw === undefined) {
			push(`worktree:${id}`, ow.headRef ?? ow.headSha, "<missing>", "error");
			continue;
		}
		compareWorktree(ow, iw, id === "main" ? "" : `worktree:${id}:`, push);
	}
	for (const [id, iw] of implWt) {
		if (!oracleWt.has(id)) {
			push(`worktree:${id}`, "<missing>", iw.headRef ?? iw.headSha, "error");
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
 * Quick check — returns true only when state matches EXACTLY (no divergences
 * of any severity). Driven by `compare()` so the fast path can never drift out
 * of lockstep with the detailed comparison (a divergence compare() flags but
 * matches() misses would silently pass the step — the worst oracle outcome).
 */
export function matches(oracle: OracleState, impl: ImplState): boolean {
	return compare(oracle, impl).length === 0;
}
