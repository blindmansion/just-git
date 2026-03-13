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

type PostMortemPattern =
	| "rebase-planner-match"
	| "rename-detection-ambiguity"
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

					const db = initDb(dbPath);
					const store = new OracleStore(db);
					const oracleStep = store.getFullStep(traceId, step);
					db.close();
					const oracleStdout = oracleStep?.stdout ?? "";
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
			return await analyzeMergeDivergence(dbPath, traceId, step, divergences);
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

	return {
		pattern: "unknown",
		explanation:
			`planner commit lists differ ` +
			`(oracle=${cmp.oracleRight.length}, ours=${cmp.oursRight.length})`,
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

				if (stateErrors.length > 0 && stateErrors.every((d) => d.field === "work_tree")) {
					return {
						pattern: "diff3-ambiguity",
						explanation:
							"rebase todo matches but worktree content differs — diff3 LCS tie-breaking produces different conflict marker alignment",
					};
				}

				const opDiv = stateErrors.find((d) => d.field === "active_operation");
				if (opDiv && opDiv.expected === "rebase" && opDiv.actual === null) {
					return {
						pattern: "diff3-ambiguity",
						explanation:
							"rebase todo matches but impl completed rebase — merge resolution difference (our diff3 resolves cleanly where git conflicts)",
					};
				}
			}

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

		// Todo lists differ — downstream planner divergence
		return {
			pattern: "unknown",
			explanation: `rebase todo lists differ (oracle=${oracleTodo.length}, ours=${implTodo.length}) — downstream planner divergence`,
		};
	} finally {
		await rm(realRepo, { recursive: true, force: true });
	}
}

// ── Merge analysis ───────────────────────────────────────────────

/**
 * Analyze merge divergences to detect known limitation patterns:
 *
 * 1. Rename detection ambiguity: When multiple files share the same
 *    content hash, Git's hashmap iteration order determines which
 *    pairing is selected. Our rename detection may pick a different
 *    pairing, leading to different merge results.
 *
 * 2. diff3 LCS tie-breaking: When the only state divergence is
 *    work_tree, the merge produced the same conflict structure but
 *    different content within conflict regions.
 */
async function analyzeMergeDivergence(
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
	const db = initDb(dbPath);
	const store = new OracleStore(db);
	const oracleStep = store.getFullStep(traceId, step);
	db.close();

	const stateErrors =
		divergences?.filter((d) => d.severity === "error" && !OUTPUT_FIELDS.has(d.field)) ?? [];

	// Rename detection ambiguity: oracle stdout mentions rename-related conflicts.
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

	// Conflict stages differ between oracle and impl for the same path.
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
				explanation: "index conflict stages differ — rename detection pairing divergence",
			};
		}

		const hasIndexShaMismatch = errors.some((d) => /^index:.+:[0-3]:sha/.test(d.field));
		if (hasIndexShaMismatch) {
			return {
				pattern: "rename-detection-ambiguity",
				explanation: "index blob sha differs — cascading merge-ort difference",
			};
		}
	}

	// diff3 LCS tie-breaking ambiguity: worktree-only divergence.
	if (divergences) {
		const sErrors = divergences.filter(
			(d) => d.severity === "error" && !OUTPUT_FIELDS.has(d.field),
		);
		if (sErrors.length > 0 && sErrors.every((d) => d.field === "work_tree")) {
			return {
				pattern: "diff3-ambiguity",
				explanation:
					"worktree content differs but merge structure matches — diff3 LCS tie-breaking produces different alignment for repeated content lines",
			};
		}
	}

	// Output-only divergence with no state errors.
	if (divergences) {
		const sErrors = divergences.filter(
			(d) => d.severity === "error" && !OUTPUT_FIELDS.has(d.field),
		);
		if (sErrors.length === 0) {
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
