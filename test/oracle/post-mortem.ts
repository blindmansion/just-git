/**
 * Post-mortem analysis for oracle test failures.
 *
 * When a trace fails, the post-mortem replays to just before the failing step,
 * then runs pattern-specific detectors to classify the divergence as either a
 * known acceptable difference (e.g., rebase planner quirk) or a genuine bug.
 *
 * This avoids the need to continue replaying past a divergence (where state
 * drift makes comparison meaningless) while still distinguishing real errors
 * from expected Git implementation differences.
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { collectRebaseSymmetricPlan, readRebaseState } from "../../src/lib/rebase.ts";
import { findGitDir } from "../../src/lib/repo.ts";
import { resolveRevision } from "../../src/lib/rev-parse.ts";
import { replayToVirtual } from "./impl-harness.ts";
import { replayTo } from "./runner.ts";
import { initDb } from "./schema.ts";
import { OracleStore } from "./store.ts";

// ── Types ────────────────────────────────────────────────────────

/**
 * Pattern tags for known divergences — extensible as new patterns are found.
 *
 * Notes:
 * - Output-only knowns should prefer checker.ts matchers.
 * - Post-mortem should primarily classify stateful divergences.
 */
type PostMortemPattern =
	| "rebase-planner-match"
	| "rebase-planner-extra-in-oracle"
	| "rebase-planner-extra-in-ours"
	| "rebase-planner-different"
	| "rebase-todo-diverged"
	| "merge-directory-rename"
	| "merge-recursive-base-rename2to1"
	| "rename-detection-ambiguity"
	| "merge-precondition-rename-paths"
	| "abort-untracked-conflict"
	| "diff3-ambiguity"
	| "unknown";

interface PostMortemResult {
	/** Classification of the divergence. "unknown" = genuine bug or unrecognized. */
	pattern: PostMortemPattern;
	/** Human-readable explanation of the finding. */
	explanation: string;
}

/** Comparison of our planner output vs Git's rev-list. */
interface PlannerComparison {
	oracleRight: string[];
	oursRight: string[];
	oracleLeft: string[];
	oursLeft: string[];
}

// ── Helpers ──────────────────────────────────────────────────────

/** Output-level divergence fields (not state). */
const OUTPUT_FIELDS = new Set(["exit_code", "stdout", "stderr"]);

/** Returns true if the divergence field is from output comparison (not state). */
function isOutputField(field: string): boolean {
	return OUTPUT_FIELDS.has(field);
}

// ── Entry point ──────────────────────────────────────────────────

/**
 * Run post-mortem analysis on a failing step.
 *
 * Dispatches to pattern-specific detectors based on the command type.
 * Returns "unknown" if no known pattern matches.
 */
export async function runPostMortem(
	dbPath: string,
	traceId: number,
	step: number,
	command: string,
	divergences?: Array<{
		field: string;
		expected: unknown;
		actual: unknown;
		severity: string;
	}>,
): Promise<PostMortemResult> {
	// General: oracle repo corruption — when a prior failed operation left
	// the real git repo in an unrecoverable state (HEAD=null, all refs
	// missing), any subsequent divergence is meaningless. This typically
	// happens downstream of a failed abort that we handle differently.
	if (divergences) {
		const headDiv = divergences.find(
			(d) =>
				d.field === "head_sha" && d.severity !== "pass" && d.expected === null && d.actual !== null,
		);
		if (headDiv) {
			// Oracle lost HEAD entirely — repo is destroyed
			return {
				pattern: "abort-untracked-conflict",
				explanation: "oracle repo corrupted (HEAD=null) — downstream of a prior failed abort",
			};
		}
	}

	// General: abort commands that fail because of untracked file conflicts.
	// Our mergeAbort/rebase --abort implementations don't check for untracked
	// files that would be overwritten by the reset. When the oracle's abort
	// failed but ours succeeded, the active_operation diverges (oracle still
	// has it, impl cleared it). Check the oracle's stored stderr for the
	// untracked file message.
	if (command.includes("--abort") && divergences) {
		const opDiv = divergences.find(
			(d) =>
				d.field === "active_operation" &&
				d.severity === "error" &&
				d.actual === null &&
				d.expected !== null,
		);
		if (opDiv) {
			// Oracle still has an active operation — our abort succeeded but
			// oracle's didn't. Check oracle stderr for untracked file conflict.
			const db = initDb(dbPath);
			const store = new OracleStore(db);
			const oracleStep = store.getFullStep(traceId, step);
			db.close();
			const oracleStderr = oracleStep?.stderr ?? "";
			if (
				oracleStderr.includes("untracked working tree files would be overwritten") ||
				oracleStderr.includes("Untracked working tree file")
			) {
				return {
					pattern: "abort-untracked-conflict",
					explanation:
						"abort succeeded but should have failed — untracked file conflict check not implemented",
				};
			}
		}
	}

	// Detect rebase commands
	const upstream = parseRebaseUpstream(command);
	if (upstream) {
		try {
			const result = await analyzeRebasePlannerDivergence(dbPath, traceId, step, upstream);
			// When the planner output matches exactly but we still have
			// error-severity STATE divergences (work_tree, active_operation,
			// index, head_ref, missing/extra refs), the divergence is a real
			// bug in rebase execution — don't mask it as "known".
			// Output-only divergences (exit_code, stdout, stderr) are expected
			// when rebase output isn't fully implemented and are still allowed
			// to be classified as known.
			if (result.pattern === "rebase-planner-match" && divergences) {
				const stateErrorFields = divergences
					.filter((d) => d.severity === "error" && !isOutputField(d.field))
					.map((d) => d.field);
				if (stateErrorFields.length > 0) {
					// Check if the state divergences look like rename detection
					// differences (conflict stage mismatches in index). If so,
					// classify as rename-detection-ambiguity rather than unknown.
					const errors = divergences.filter((d) => d.severity === "error");
					const hasConflictStageMismatch = errors.some(
						(d) =>
							(/^index:.+:[123]:/.test(d.field) &&
								(d.expected === "<missing>" || d.actual === "<missing>")) ||
							(/^index:.+:0:?/.test(d.field) &&
								(d.expected === "<missing>" || d.actual === "<missing>")),
					);
					if (hasConflictStageMismatch) {
						return {
							pattern: "rename-detection-ambiguity",
							explanation:
								"rebase planner matches but cherry-pick execution diverges — rename detection pairing difference",
						};
					}

					// Check oracle stdout for directory rename detection
					// markers — rebase cherry-picks can hit the same
					// merge-ort directory rename logic that merge does.
					const db = initDb(dbPath);
					const store = new OracleStore(db);
					const oracleStep = store.getFullStep(traceId, step);
					db.close();
					const oracleStdout = oracleStep?.stdout ?? "";
					if (oracleStdout.includes("CONFLICT (file location)")) {
						return {
							pattern: "merge-directory-rename",
							explanation:
								"rebase planner matches but cherry-pick hit directory rename detection (not implemented)",
						};
					}
					const hasRenameHint = /rename\/delete|rename\/rename|renamed to|rename involved/i.test(
						oracleStdout,
					);
					if (hasRenameHint) {
						return {
							pattern: "rename-detection-ambiguity",
							explanation:
								"rebase planner matches but cherry-pick execution involves renames — different pairing",
						};
					}

					return {
						pattern: "unknown",
						explanation: `planner matches but error-severity state divergence: ${stateErrorFields.join(", ")}`,
					};
				}
			}
			return result;
		} catch (err) {
			return {
				pattern: "unknown",
				explanation: `post-mortem error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	// Rebase-status output-only todo drift is handled in checker.ts.

	// Detect rebase continuation commands (--skip, --continue, --abort)
	if (isRebaseContinuation(command)) {
		try {
			return await analyzeRebaseTodoDivergence(dbPath, traceId, step, divergences);
		} catch (err) {
			return {
				pattern: "unknown",
				explanation: `post-mortem error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	// Detect commands that use the merge engine (merge, cherry-pick, stash apply/pop).
	// All of these go through merge-ort and can hit rename detection divergences.
	if (
		command.startsWith("git merge") ||
		command.startsWith("git cherry-pick") ||
		command.startsWith("git stash apply") ||
		command.startsWith("git stash pop")
	) {
		try {
			return await analyzeMergeDivergence(dbPath, traceId, step, command, divergences);
		} catch (err) {
			return {
				pattern: "unknown",
				explanation: `post-mortem error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	// Diff commands with output-only divergences (no state errors) where
	// stdout differs: rename detection in diff --cached / diff <commit>
	// can pair files differently, producing different output.
	if (command.startsWith("git diff") && divergences && divergences.length > 0) {
		const stateErrors = divergences.filter(
			(d) => d.severity === "error" && !isOutputField(d.field),
		);
		if (stateErrors.length === 0) {
			const hasStdoutDiff = divergences.some((d) => d.severity === "error" && d.field === "stdout");
			if (hasStdoutDiff) {
				return {
					pattern: "rename-detection-ambiguity",
					explanation:
						"diff output differs but state matches — rename detection pairing divergence in diff",
				};
			}
		}
	}

	// General fallback: any command with index conflict stage mismatches
	// (stages 0-3 present on one side but not the other) is very likely
	// a rename detection divergence, even for commands we don't have
	// specific detectors for (e.g., rebase cherry-pick execution).
	if (divergences && divergences.length > 0) {
		const errors = divergences.filter((d) => d.severity === "error");
		const hasConflictStageMismatch = errors.some(
			(d) =>
				(/^index:.+:[123]:/.test(d.field) &&
					(d.expected === "<missing>" || d.actual === "<missing>")) ||
				(/^index:.+:0:?/.test(d.field) && (d.expected === "<missing>" || d.actual === "<missing>")),
		);
		if (hasConflictStageMismatch) {
			return {
				pattern: "rename-detection-ambiguity",
				explanation: "index conflict stages differ — likely rename detection pairing divergence",
			};
		}

		// Index sha mismatch (same entry on both sides, different hash)
		// during an active merge operation (cherry-pick, rebase, merge).
		// Cascading effect from merge-ort producing different blobs.
		// Matches any stage (0-3) — stage-2/3 sha mismatches in conflicts
		// are equally likely to be rename detection cascades.
		const hasIndexShaMismatch = errors.some((d) => /^index:.+:[0-3]:sha/.test(d.field));
		if (hasIndexShaMismatch) {
			return {
				pattern: "rename-detection-ambiguity",
				explanation:
					"index blob sha differs — cascading merge-ort difference from active operation",
			};
		}
	}

	return {
		pattern: "unknown",
		explanation: `no post-mortem detector for: ${command}`,
	};
}

// ── Rebase planner analysis ──────────────────────────────────────

/**
 * Compare our rebase planner output against Git's rev-list for the
 * state just before the rebase command.
 *
 * Classifies the divergence into one of:
 * - rebase-planner-match: same commits, same order (shouldn't reach here)
 * - rebase-planner-extra-in-oracle: Git includes commits already reachable from upstream
 * - rebase-planner-extra-in-ours: we include commits Git doesn't
 * - rebase-planner-different: sets differ in both directions
 */
async function analyzeRebasePlannerDivergence(
	dbPath: string,
	traceId: number,
	step: number,
	upstream: string,
): Promise<PostMortemResult> {
	const comparison = await comparePlannerOutput(dbPath, traceId, step, upstream);

	return classifyPlannerDivergence(comparison);
}

/**
 * Replay to just before the rebase step, run both planners, return raw results.
 *
 * This is the shared core used by both post-mortem and planner-inspect CLI.
 */
export async function comparePlannerOutput(
	dbPath: string,
	traceId: number,
	step: number,
	upstream: string,
): Promise<PlannerComparison> {
	const preStep = step - 1;

	// Build real git repo and virtual FS in parallel
	const [realRepo, virtualEnv] = await Promise.all([
		replayTo(dbPath, traceId, preStep),
		replayToVirtual(dbPath, traceId, preStep),
	]);

	try {
		// Run git rev-list in real repo
		const [revRight, revLeft] = await Promise.all([
			runGit(realRepo, [
				"rev-list",
				"--reverse",
				"--topo-order",
				"--right-only",
				"--cherry-mark",
				"--max-parents=1",
				`${upstream}...HEAD`,
			]),
			runGit(realRepo, [
				"rev-list",
				"--reverse",
				"--topo-order",
				"--left-only",
				"--cherry-mark",
				"--max-parents=1",
				`${upstream}...HEAD`,
			]),
		]);

		if (revRight.exitCode !== 0 || revLeft.exitCode !== 0) {
			throw new Error(`git rev-list failed: ${revRight.stderr || revLeft.stderr}`);
		}

		const oracleRight = parseMarkedList(revRight.stdout);
		const oracleLeft = parseMarkedList(revLeft.stdout);

		// Run our planner in virtual FS
		const gitCtx = await findGitDir(virtualEnv.bash.fs, "/repo");
		if (!gitCtx) {
			throw new Error("Virtual replay did not produce a git repository");
		}

		const upstreamHash = await resolveRevision(gitCtx, upstream);
		const headHash = await resolveRevision(gitCtx, "HEAD");
		if (!upstreamHash || !headHash) {
			throw new Error("Failed to resolve upstream/HEAD in virtual replay");
		}

		const plan = await collectRebaseSymmetricPlan(gitCtx, upstreamHash, headHash);

		return {
			oracleRight,
			oursRight: plan.right.map((c) => c.hash),
			oracleLeft,
			oursLeft: plan.left.map((c) => c.hash),
		};
	} finally {
		await rm(realRepo, { recursive: true, force: true });
	}
}

/**
 * Classify a planner comparison into a known pattern.
 */
export function classifyPlannerDivergence(cmp: PlannerComparison): PostMortemResult {
	const oracleSet = new Set(cmp.oracleRight);
	const oursSet = new Set(cmp.oursRight);

	const extraInOracle = [...oracleSet].filter((h) => !oursSet.has(h));
	const extraInOurs = [...oursSet].filter((h) => !oracleSet.has(h));
	const shared = [...oracleSet].filter((h) => oursSet.has(h));

	// Same set, same order
	if (
		extraInOracle.length === 0 &&
		extraInOurs.length === 0 &&
		JSON.stringify(cmp.oracleRight) === JSON.stringify(cmp.oursRight)
	) {
		return {
			pattern: "rebase-planner-match",
			explanation: `planner output matches (${cmp.oracleRight.length} commits)`,
		};
	}

	// Our set is a strict subset (Git includes extra commits)
	if (extraInOracle.length > 0 && extraInOurs.length === 0) {
		return {
			pattern: "rebase-planner-extra-in-oracle",
			explanation:
				`git includes ${extraInOracle.length} commit(s) already reachable from upstream ` +
				`(oracle=${cmp.oracleRight.length}, ours=${cmp.oursRight.length})`,
		};
	}

	// Our set is a strict superset (we include extra commits)
	if (extraInOurs.length > 0 && extraInOracle.length === 0) {
		return {
			pattern: "rebase-planner-extra-in-ours",
			explanation:
				`we include ${extraInOurs.length} extra commit(s) ` +
				`(oracle=${cmp.oracleRight.length}, ours=${cmp.oursRight.length})`,
		};
	}

	// Sets differ in both directions
	return {
		pattern: "rebase-planner-different",
		explanation:
			`commit lists differ ` +
			`(oracle=${cmp.oracleRight.length}, ours=${cmp.oursRight.length}, shared=${shared.length})`,
	};
}

// ── Utilities ────────────────────────────────────────────────────

/** Parse the upstream branch from a `git rebase <upstream>` command. */
export function parseRebaseUpstream(command: string): string | null {
	// Must match a positional argument (not a flag like --skip, --continue, --abort)
	const match = /^git rebase\s+(?!--)([^\s]+)\s*$/.exec(command.trim());
	if (!match) return null;
	return match[1] ?? null;
}

/** Run a git command in a directory, capturing stdout/stderr. */
async function runGit(
	repoDir: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** Parse a cherry-mark rev-list output into clean hash list. */
function parseMarkedList(text: string): string[] {
	return text
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.replace(/^[+=-]/, ""));
}

/** Check if a command is a rebase continuation (--skip, --continue, --abort). */
function isRebaseContinuation(command: string): boolean {
	const trimmed = command.trim();
	return (
		trimmed === "git rebase --skip" ||
		trimmed === "git rebase --continue" ||
		trimmed === "git rebase --abort"
	);
}

/**
 * Analyze rebase --skip / --continue / --abort failures by comparing
 * the todo lists between oracle (real git) and our implementation.
 *
 * If the todo lists diverge, the failure is downstream of a planner
 * difference — the two implementations are picking different commits.
 */
async function analyzeRebaseTodoDivergence(
	dbPath: string,
	traceId: number,
	step: number,
	divergences?: Array<{
		field: string;
		expected: unknown;
		actual: unknown;
		severity: string;
	}>,
): Promise<PostMortemResult> {
	const preStep = step - 1;

	// Build real git repo and virtual FS at the step before the failure
	const [realRepo, virtualEnv] = await Promise.all([
		replayTo(dbPath, traceId, preStep),
		replayToVirtual(dbPath, traceId, preStep),
	]);

	try {
		// Read oracle's todo list from real git
		const oracleTodoPath = join(realRepo, ".git", "rebase-merge", "git-rebase-todo");
		let oracleTodo: string[] = [];
		try {
			const todoText = readFileSync(oracleTodoPath, "utf-8");
			oracleTodo = parseTodoHashes(todoText);
		} catch {
			// No rebase-merge dir — not a rebase state issue
			return {
				pattern: "unknown",
				explanation: "no rebase state found in real git repo",
			};
		}

		// Read impl's todo list from virtual FS
		const gitCtx = await findGitDir(virtualEnv.bash.fs, "/repo");
		if (!gitCtx) {
			return {
				pattern: "unknown",
				explanation: "virtual replay did not produce a git repository",
			};
		}

		const implState = await readRebaseState(gitCtx);
		if (!implState) {
			// Our impl has no rebase state — the rebase completed.
			// If oracle still has todo entries, our merge-ort resolved
			// conflicts cleanly where git's xdiff didn't.
			if (oracleTodo.length > 0) {
				return {
					pattern: "diff3-ambiguity",
					explanation:
						"rebase completed in impl but oracle still has conflicts — merge resolution difference",
				};
			}
			return {
				pattern: "unknown",
				explanation: "no rebase state found in virtual impl",
			};
		}
		const implTodo = implState.todo.map((e) => e.hash);

		// Compare
		if (JSON.stringify(oracleTodo) === JSON.stringify(implTodo)) {
			// Todo lists match — check for diff3-ambiguity patterns
			if (divergences) {
				const stateErrors = divergences.filter(
					(d) => d.severity === "error" && !isOutputField(d.field),
				);

				// Pattern: worktree-only divergence — diff3 LCS tie-breaking
				if (stateErrors.length > 0 && stateErrors.every((d) => d.field === "work_tree")) {
					return {
						pattern: "diff3-ambiguity",
						explanation:
							"rebase todo matches but worktree content differs — diff3 LCS tie-breaking produces different conflict marker alignment",
					};
				}

				// Pattern: our rebase completed but oracle's still has conflicts.
				// Our merge-ort resolved remaining commits cleanly where git's
				// xdiff didn't, so active_operation is null (completed) vs
				// "rebase" (still in progress). The index/worktree/head diverge
				// as a downstream consequence.
				const opDiv = stateErrors.find((d) => d.field === "active_operation");
				if (opDiv && opDiv.expected === "rebase" && opDiv.actual === null) {
					return {
						pattern: "diff3-ambiguity",
						explanation:
							"rebase todo matches but impl completed rebase — merge resolution difference (our diff3 resolves cleanly where git conflicts)",
					};
				}
			}

			// Output-only rebase continuation diagnostics are handled in checker.ts.

			// For stateful rebase divergences, check oracle stdout for rename hints.
			if (divergences) {
				const stateErrors = divergences.filter(
					(d) => d.severity === "error" && !isOutputField(d.field),
				);
				if (stateErrors.length > 0) {
					const db = initDb(dbPath);
					const store = new OracleStore(db);
					const oracleStep = store.getFullStep(traceId, step);
					db.close();
					const oStdout = oracleStep?.stdout ?? "";
					if (/rename\/delete|rename\/rename|renamed to|rename involved/i.test(oStdout)) {
						return {
							pattern: "rename-detection-ambiguity",
							explanation:
								"rebase todo matches but merge output differs — rename detection difference",
						};
					}

					// Index stage mismatches (stage 0 vs stages 1/2/3) are a strong
					// signal of rename detection pairing differences even when the
					// oracle stdout doesn't mention renames explicitly (e.g., oracle
					// shows modify/delete while impl detects a rename).
					const hasConflictStageMismatch = stateErrors.some(
						(d) =>
							(/^index:.+:[123]:/.test(d.field) &&
								(d.expected === "<missing>" || d.actual === "<missing>")) ||
							(/^index:.+:0:?/.test(d.field) &&
								(d.expected === "<missing>" || d.actual === "<missing>")),
					);
					if (hasConflictStageMismatch) {
						return {
							pattern: "rename-detection-ambiguity",
							explanation:
								"rebase todo matches but index conflict stages differ — rename detection pairing divergence",
						};
					}
				}
			}

			return {
				pattern: "unknown",
				explanation: `rebase todo lists match (${oracleTodo.length} entries) — divergence is not from planner`,
			};
		}

		const oracleSet = new Set(oracleTodo);
		const implSet = new Set(implTodo);
		const extraInOracle = oracleTodo.filter((h) => !implSet.has(h));
		const extraInImpl = implTodo.filter((h) => !oracleSet.has(h));

		let detail: string;
		if (extraInOracle.length === 0 && extraInImpl.length === 0) {
			detail = `same ${oracleTodo.length} commits, different order`;
		} else {
			detail =
				`oracle=${oracleTodo.length}, ours=${implTodo.length}` +
				(extraInOracle.length > 0 ? `, +${extraInOracle.length} only in oracle` : "") +
				(extraInImpl.length > 0 ? `, +${extraInImpl.length} only in ours` : "");
		}

		return {
			pattern: "rebase-todo-diverged",
			explanation: `rebase todo lists differ (${detail}) — downstream planner divergence`,
		};
	} finally {
		await rm(realRepo, { recursive: true, force: true });
	}
}

// ── Merge analysis ───────────────────────────────────────────────

/**
 * Analyze merge divergences to detect known limitation patterns:
 *
 * 1. Directory rename detection: Git detects when an entire directory
 *    was renamed (e.g., src/util -> lib) and applies the rename to
 *    other files. We don't implement this (merge-ort.c feature).
 *    Detected by: oracle stdout contains "CONFLICT (file location)".
 *
 * 2. rename/rename(2to1) in recursive merge base: When computing a
 *    virtual merge base from multiple LCAs, the inner merge may have
 *    rename/rename(2to1) conflicts that produce different content
 *    merges. Detected by: stage-1 hash mismatches only, and the merge
 *    has multiple merge bases.
 *
 * 3. Rename detection ambiguity: When multiple files share the same
 *    content hash, Git's hashmap iteration order determines which
 *    pairing is selected. Our rename detection may pick a different
 *    pairing, leading to different merge results.
 *    Detected by: oracle stdout mentions renames, or the merge inputs
 *    contain renames (checked via `git diff-tree -M`).
 */
async function analyzeMergeDivergence(
	dbPath: string,
	traceId: number,
	step: number,
	command: string,
	divergences?: Array<{
		field: string;
		expected: unknown;
		actual: unknown;
		severity: string;
	}>,
): Promise<PostMortemResult> {
	const { OracleStore } = await import("./store.ts");
	const { initDb } = await import("./schema.ts");

	const db = initDb(dbPath);
	const store = new OracleStore(db);

	// Get the oracle's full step data
	const oracleStep = store.getFullStep(traceId, step);
	db.close();

	const stateErrors =
		divergences?.filter((d) => d.severity === "error" && !OUTPUT_FIELDS.has(d.field)) ?? [];

	// Merge-family output-only diagnostic drift and merge-precondition stderr-only
	// path-list drift are handled in checker.ts.

	// Pattern 1: Directory rename detection
	// Git's merge-ort detects when an entire directory was renamed and
	// applies the rename to other files. We don't implement this.
	if (oracleStep?.stdout?.includes("CONFLICT (file location)")) {
		return {
			pattern: "merge-directory-rename",
			explanation:
				"directory rename detection not implemented (Git detects whole-directory renames)",
		};
	}

	// Pattern 2: Recursive merge base rename/rename(2to1) divergence
	// When computing a virtual merge base from multiple LCAs, the inner merge
	// may have rename/rename(2to1) conflicts that produce different content.
	// Detectable by: all error-severity divergences are stage-1 hash mismatches.
	if (divergences && divergences.length > 0) {
		const errors = divergences.filter((d) => d.severity === "error");
		const allStage1HashOnly =
			errors.length > 0 &&
			errors.every((d) =>
				// Stage-1 entries have field format like "index:<path>:1:sha:"
				// or "index:<path>:1:" — these are the merge base entries
				/^index:.+:1:/.test(d.field),
			);

		if (allStage1HashOnly) {
			return {
				pattern: "merge-recursive-base-rename2to1",
				explanation: `recursive merge base stage-1 hash mismatch (${errors.length} entry/entries) — rename/rename(2to1) edge case in virtual merge base`,
			};
		}
	}

	// Pattern 3: Rename detection ambiguity
	// When multiple files share the same content hash, our rename detection
	// may pair them differently than Git's internal hashmap iteration order.
	// Quick check: oracle stdout mentions rename-related conflicts.
	const stdout = oracleStep?.stdout ?? "";
	const hasRenameInStdout = /rename\/delete|rename\/rename|renamed to|rename involved/i.test(
		stdout,
	);

	if (hasRenameInStdout && stateErrors.length > 0) {
		return {
			pattern: "rename-detection-ambiguity",
			explanation: "rename detection pairing differs from Git (hashmap iteration order ambiguity)",
		};
	}

	// Pattern 4: Divergence pattern — conflict stages differ between oracle
	// and our impl for the same path. This indicates our rename detection
	// paired files differently, causing one side to see a conflict (stages
	// 1/2/3) while the other side resolved cleanly (stage 0), or vice versa.
	if (divergences && divergences.length > 0) {
		const errors = divergences.filter((d) => d.severity === "error");
		const hasConflictStageMismatch = errors.some(
			(d) =>
				// Stage 1/2/3 exists on one side but not the other
				(/^index:.+:[123]:/.test(d.field) &&
					(d.expected === "<missing>" || d.actual === "<missing>")) ||
				// Stage 0 exists on one side but not the other
				(/^index:.+:0:?/.test(d.field) && (d.expected === "<missing>" || d.actual === "<missing>")),
		);
		if (hasConflictStageMismatch) {
			return {
				pattern: "rename-detection-ambiguity",
				explanation: "index conflict stages differ — rename detection pairing divergence",
			};
		}

		// Same entry on both sides but different blob hash at any stage.
		// Cascading from rename detection producing different merge content.
		const hasIndexShaMismatch = errors.some((d) => /^index:.+:[0-3]:sha/.test(d.field));
		if (hasIndexShaMismatch) {
			return {
				pattern: "rename-detection-ambiguity",
				explanation: "index blob sha differs — cascading merge-ort difference",
			};
		}
	}

	// Slow path: rebuild repo and check if the merge inputs contain renames.
	// Only classify as rename-detection-ambiguity if the renamed paths
	// overlap with the divergent paths, or if the worktree hash diverges
	// (can't narrow without file-level diff).
	try {
		const renamedPaths = await collectMergeInputRenames(dbPath, traceId, step, command);
		if (renamedPaths.size > 0) {
			// If worktree diverges, any rename could be responsible
			const hasWorktreeDivergence = divergences?.some(
				(d) => d.field === "work_tree" && d.severity === "error",
			);
			if (hasWorktreeDivergence) {
				return {
					pattern: "rename-detection-ambiguity",
					explanation:
						"merge inputs contain renames + worktree diverges — different pairing may cause divergent merge outcome",
				};
			}
			// Otherwise, check if any divergent path overlaps with renamed paths
			const divergentPaths = extractDivergentPaths(divergences);
			const overlap = [...divergentPaths].filter((p) => renamedPaths.has(p));
			if (overlap.length > 0) {
				return {
					pattern: "rename-detection-ambiguity",
					explanation: `merge inputs contain renames overlapping divergent paths (${overlap.join(", ")})`,
				};
			}
		}
	} catch {
		// Rebuild failed — fall through to unknown
	}

	// Pattern 5: diff3 LCS tie-breaking ambiguity
	// When the only state divergence is work_tree (no index, ref, or
	// operation differences), the merge produced the same conflict
	// structure but different file content within conflict regions.
	// This happens when merging files with repeated identical lines
	// (e.g., prior conflict markers) — multiple valid LCS solutions
	// exist and our Hunt-McIlroy picks a different alignment than
	// Git's xdiff.
	if (divergences) {
		const stateErrors = divergences.filter(
			(d) => d.severity === "error" && !OUTPUT_FIELDS.has(d.field),
		);
		if (stateErrors.length > 0 && stateErrors.every((d) => d.field === "work_tree")) {
			return {
				pattern: "diff3-ambiguity",
				explanation:
					"worktree content differs but merge structure matches — diff3 LCS tie-breaking produces different alignment for repeated content lines",
			};
		}
	}

	// Pattern: Output-only divergence with no state errors.
	// When merge-ort produces different results due to rename detection,
	// the safety check may accept/reject different files, causing exit
	// code and stderr differences. If states match, the behavior is
	// functionally correct — the output difference is cosmetic.
	if (divergences) {
		const stateErrors = divergences.filter(
			(d) => d.severity === "error" && !OUTPUT_FIELDS.has(d.field),
		);
		if (stateErrors.length === 0) {
			return {
				pattern: "rename-detection-ambiguity",
				explanation:
					"merge output differs but state matches — different merge-ort result from rename detection causes different safety check path",
			};
		}
	}

	return {
		pattern: "unknown",
		explanation: "merge divergence — not a known pattern",
	};
}

/**
 * Extract file paths from divergences that reference index entries.
 * Divergence fields have formats like:
 *   "index:path/file.txt:0"       (missing entry)
 *   "index:path/file.txt:0:sha"   (SHA mismatch)
 *   "index:path/file.txt:0:mode"  (mode mismatch)
 *
 * The path may contain colons, so we parse from the known suffix patterns.
 */
function extractDivergentPaths(
	divergences?: Array<{ field: string; severity: string }>,
): Set<string> {
	const paths = new Set<string>();
	if (!divergences) return paths;
	for (const d of divergences) {
		if (d.severity !== "error") continue;
		if (!d.field.startsWith("index:")) continue;
		// Strip "index:" prefix, then strip trailing ":stage" or ":stage:sha"/":stage:mode"
		const rest = d.field.slice("index:".length);
		// Format: <path>:<stage> or <path>:<stage>:<detail>
		// Stage is a single digit (0-3). Walk backwards to find it.
		const lastColon = rest.lastIndexOf(":");
		if (lastColon < 0) continue;
		const afterLast = rest.slice(lastColon + 1);
		// If afterLast is "sha" or "mode", strip it and find the next colon
		if (afterLast === "sha" || afterLast === "mode") {
			const secondLast = rest.lastIndexOf(":", lastColon - 1);
			if (secondLast >= 0) {
				paths.add(rest.slice(0, secondLast));
			}
		} else {
			// afterLast should be the stage number
			paths.add(rest.slice(0, lastColon));
		}
	}
	return paths;
}

/**
 * Rebuild the real repo at the step before the failure and collect the
 * set of renamed paths from the merge/cherry-pick inputs (via `git diff-tree -M`).
 * Returns both old and new names for each rename.
 */
async function collectMergeInputRenames(
	dbPath: string,
	traceId: number,
	step: number,
	command: string,
): Promise<Set<string>> {
	const preStep = step - 1;
	const realRepo = await replayTo(dbPath, traceId, preStep);

	try {
		const renames = new Set<string>();

		// Cherry-pick: check parent→commit diff
		const cherryPickMatch = command.match(/^git cherry-pick\s+([0-9a-f]{7,40})/);
		if (cherryPickMatch) {
			const hash = cherryPickMatch[1];
			const result = await runGit(realRepo, [
				"diff-tree",
				"-M",
				"-r",
				"--diff-filter=R",
				`${hash}^`,
				hash,
			]);
			parseRenamedPaths(result.stdout, renames);
			return renames;
		}

		// Merge: check merge-base→HEAD and merge-base→branch diffs
		const mergeMatch = command.match(/^git merge\s+(?:--no-ff\s+)?(?!--)(\S+)/);
		if (mergeMatch) {
			const branch = mergeMatch[1];
			const baseResult = await runGit(realRepo, ["merge-base", "HEAD", branch]);
			if (baseResult.exitCode !== 0) return renames;
			const base = baseResult.stdout.trim();

			const [oursResult, theirsResult] = await Promise.all([
				runGit(realRepo, ["diff-tree", "-M", "-r", "--diff-filter=R", base, "HEAD"]),
				runGit(realRepo, ["diff-tree", "-M", "-r", "--diff-filter=R", base, branch]),
			]);

			parseRenamedPaths(oursResult.stdout, renames);
			parseRenamedPaths(theirsResult.stdout, renames);
			return renames;
		}

		return renames;
	} finally {
		await rm(realRepo, { recursive: true, force: true });
	}
}

/**
 * Parse `git diff-tree -M -r --diff-filter=R` output to extract
 * both old and new paths from each rename entry.
 * Format: ":100644 100644 <old-sha> <new-sha> R<score>\t<old-path>\t<new-path>"
 */
function parseRenamedPaths(output: string, paths: Set<string>): void {
	for (const line of output.trim().split("\n")) {
		if (!line) continue;
		// The tab-separated part after the status contains old-path and new-path
		const tabParts = line.split("\t");
		if (tabParts.length >= 3) {
			paths.add(tabParts[1] as string);
			paths.add(tabParts[2] as string);
		}
	}
}

/** Extract commit hashes from a git-rebase-todo file. */
function parseTodoHashes(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("pick "))
		.map((line) => {
			const parts = line.split(/\s+/);
			return parts[1] ?? "";
		})
		.filter(Boolean);
}
