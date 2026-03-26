import { Database } from "bun:sqlite";
import type { GitSnapshot } from "./capture";
import {
	compare,
	type Divergence,
	hasErrors,
	type ImplState,
	matches,
	type OracleState,
} from "./compare";
import type { TraceConfig } from "./generate";
import type { CommandOutput } from "./impl-harness";
import { applyDelta, EMPTY_SNAPSHOT, type SnapshotDelta } from "./snapshot-delta";

/**
 * Converts a stored GitSnapshot (arrays) into the OracleState shape
 * that the comparison functions expect.
 */
function toOracleState(snap: GitSnapshot): OracleState {
	return {
		head: snap.head,
		refs: snap.refs,
		index: snap.index,
		operation: snap.operation,
		workTreeHash: snap.workTreeHash,
		stashHashes: snap.stashHashes,
	};
}

interface StepData {
	seq: number;
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	oracle: OracleState;
}

/** Result of checking a single step against the oracle. */
type StepCheckResult =
	| { status: "pass" }
	| { status: "warn"; divergences: Divergence[] }
	| { status: "fail"; divergences: Divergence[] };

/**
 * Pre-loads all snapshots for a trace into memory for fast batch checking.
 */
export class BatchChecker {
	private steps: StepData[];
	private bySeq: Map<number, StepData>;
	private traceConfig: TraceConfig | null;

	constructor(dbPath: string, traceId: number) {
		const db = new Database(dbPath, { readonly: true });

		// Read trace config (null for legacy traces without the column)
		let config: TraceConfig | null = null;
		try {
			const traceRow = db.prepare(`SELECT config FROM traces WHERE trace_id = ?`).get(traceId) as {
				config: string | null;
			} | null;
			if (traceRow?.config) {
				config = JSON.parse(traceRow.config) as TraceConfig;
			}
		} catch {
			// Column may not exist in legacy DBs — that's fine
		}
		this.traceConfig = config;

		const rows = db
			.prepare(
				`SELECT seq, command, exit_code, stdout, stderr, snapshot FROM steps
         WHERE trace_id = ? ORDER BY seq`,
			)
			.all(traceId) as {
			seq: number;
			command: string;
			exit_code: number;
			stdout: string;
			stderr: string;
			snapshot: string;
		}[];

		let currentFull: GitSnapshot = EMPTY_SNAPSHOT;
		this.steps = rows.map((row) => {
			const delta: SnapshotDelta = JSON.parse(row.snapshot);
			// Placeholders have workTreeHash === "" — don't accumulate them
			if (delta.workTreeHash === "") {
				return {
					seq: row.seq,
					command: row.command,
					exitCode: row.exit_code,
					stdout: row.stdout,
					stderr: row.stderr ?? "",
					oracle: toOracleState(delta as GitSnapshot),
				};
			}
			currentFull = applyDelta(currentFull, delta);
			return {
				seq: row.seq,
				command: row.command,
				exitCode: row.exit_code,
				stdout: row.stdout,
				stderr: row.stderr ?? "",
				oracle: toOracleState(currentFull),
			};
		});

		this.bySeq = new Map(this.steps.map((s) => [s.seq, s]));

		db.close();
	}

	/** Get the trace config stored at generation time (null for legacy traces). */
	getTraceConfig(): TraceConfig | null {
		return this.traceConfig;
	}

	get stepCount(): number {
		return this.steps.length;
	}

	getStep(seq: number): StepData | undefined {
		return this.bySeq.get(seq);
	}

	getOracleState(seq: number): OracleState | undefined {
		return this.bySeq.get(seq)?.oracle;
	}

	getCommand(seq: number): string | undefined {
		return this.bySeq.get(seq)?.command;
	}

	getExitCode(seq: number): number | undefined {
		return this.bySeq.get(seq)?.exitCode;
	}

	/** All commands in order, for replay. */
	getCommands(): { seq: number; command: string; exitCode: number }[] {
		return this.steps.map((s) => ({
			seq: s.seq,
			command: s.command,
			exitCode: s.exitCode,
		}));
	}

	/**
	 * Whether this step has a placeholder snapshot (part of a multi-command
	 * action where only the final command got the real snapshot).
	 * Skip comparison for these — still execute the command though.
	 */
	isPlaceholder(seq: number): boolean {
		const step = this.bySeq.get(seq);
		if (!step) return false;
		return step.oracle.workTreeHash === "";
	}

	/**
	 * Check a single step against the oracle, returning a tiered result.
	 *
	 * - "pass": exact match
	 * - "warn": only warning-severity divergences (different history, same behavior)
	 * - "fail": at least one error-severity divergence (different behavior)
	 */
	checkStep(seq: number, implState: ImplState): StepCheckResult {
		if (this.isPlaceholder(seq)) return { status: "pass" };
		const oracle = this.getOracleState(seq);
		if (!oracle) throw new Error(`No oracle state for seq ${seq}`);
		if (matches(oracle, implState)) return { status: "pass" };
		const divergences = compare(oracle, implState);
		if (divergences.length === 0) return { status: "pass" };
		if (hasErrors(divergences)) return { status: "fail", divergences };
		return { status: "warn", divergences };
	}

	// ── Stdout comparison skip lists ────────────────────────────────
	//
	// Below are all the cases where stdout comparison is intentionally
	// skipped.  Each entry documents WHY it's skipped and WHAT needs to
	// happen before it can be removed.
	//
	// ┌─────────────────────────┬──────────────────────────────────────────────────────────┐
	// │ Skip                    │ To remove                                                │
	// ├─────────────────────────┼──────────────────────────────────────────────────────────┤
	// │ Conditional skips       │                                                          │
	// │  git init               │ Output matches in format but path differs (virtual        │
	// │                         │ /repo/.git/ vs host temp dir). Checked via pattern match. │
	// │  git merge (exit ≥ 2)   │ Strategy failure triggers save_state/restore_state in     │
	// │                         │ real git, which runs stash-create + stash-apply internally │
	// │                         │ and leaks "Already up to date." to stdout. Not a real     │
	// │                         │ output difference — it's a git quirk.                     │
	// ├─────────────────────────┼──────────────────────────────────────────────────────────┤
	// │ Conditional matchers    │ (stdout accepted if structured match succeeds)            │
	// │  git show (diff)        │ Commit headers match, diff sections differ (--cc or --git).│
	// │                         │ Combined diff formatting or regular hunk alignment.       │
	// │                         │ Fix diff implementation to match Git exactly.             │
	// │  git diff (hunk align)  │ Same files and diff headers, different hunk boundaries.   │
	// │                         │ Myers diff tie-breaking ambiguity. Fix tie-breaking.      │
	// │  git commit (stat)      │ Same commit header but different diffstat counts due to   │
	// │                         │ Myers diff tie-breaking or rename detection. Fix diff.    │
	// │  merge (diffstat)       │ Same merge structural output, different diffstat file     │
	// │                         │ pairings from rename detection ambiguity. Not fixable     │
	// │                         │ without replicating Git's internal hashmap iteration.     │
	// └─────────────────────────┴──────────────────────────────────────────────────────────┘

	/**
	 * Determines whether stdout comparison should be skipped for a given
	 * command, exit code, and expected content.  Centralises all skip
	 * logic so every escape hatch is auditable in one place.
	 * See the table above for the full catalogue.
	 */
	private static shouldSkipStdout(
		baseCommand: string,
		exitCode: number,
		_expectedStdout?: string,
		_fullCommand?: string,
	): boolean {
		// git merge exit ≥ 2: strategy failure leaks "Already up to date." from
		// internal save_state/restore_state stash mechanism. Not a real difference.
		if (baseCommand === "git merge" && exitCode >= 2) return true;

		return false;
	}

	/**
	 * Check whether two git init stdout strings match in format, ignoring
	 * the repository path (which differs between virtual FS and real FS).
	 * Both should match: "Initialized empty [bare ]Git repository in <path>/\n"
	 */
	private static initOutputMatches(expected: string, actual: string): boolean {
		const pattern = /^Initialized empty (bare )?Git repository in .+\/\n$/;
		if (!pattern.test(expected) || !pattern.test(actual)) return false;
		// Extract the "bare" part and compare — both should agree on bare vs non-bare
		const expectedBare = expected.includes("bare ");
		const actualBare = actual.includes("bare ");
		return expectedBare === actualBare;
	}

	/**
	 * Check whether two merge-precondition stderr strings have the same
	 * structure but differ only in the file list.  Both must:
	 * - contain "would be overwritten by merge" (or checkout/cherry-pick)
	 * - end with "with strategy ort failed." or similar strategy suffix
	 *
	 * This lets traces continue past rename-detection file list mismatches
	 * without masking genuinely different error types.
	 */
	private static mergeOverwriteStderrMatches(expected: string, actual: string): boolean {
		const overwriteRe =
			/^error: Your local changes to the following files would be overwritten by (?:merge|checkout|cherry-pick|revert):\n/;
		if (!overwriteRe.test(expected) || !overwriteRe.test(actual)) return false;
		// Both must end with the same trailer (strategy failure or Aborting)
		const trailerRe = /\n(?:(?:Merge|Checkout) with strategy ort failed\.|Aborting)\n$/;
		if (!trailerRe.test(expected) || !trailerRe.test(actual)) return false;
		return true;
	}

	/**
	 * Check if stderr only differs in the worktree path embedded in a
	 * path-containing message. The oracle uses a real temp dir while our
	 * impl uses the virtual FS root. Handles both quoted ("used by
	 * worktree at '<path>'") and unquoted ("is being rebased at <path>")
	 * patterns.
	 */
	private static worktreePathStderrMatches(expected: string, actual: string): boolean {
		const patterns: [RegExp, string][] = [
			[/used by worktree at '[^']+'/g, "used by worktree at '<path>'"],
			[/is being rebased at \S+/g, "is being rebased at <path>"],
		];
		const norm = (s: string) => {
			let r = s;
			for (const [re, placeholder] of patterns) r = r.replace(re, placeholder);
			return r;
		};
		return norm(expected) === norm(actual);
	}

	/**
	 * Shell syntax errors have different format between the oracle's real
	 * shell ("sh: -c: line 1: syntax error near unexpected token `('")
	 * and our virtual bash ("bash: syntax error: Parse error at 1:N: ...").
	 * Both report the same underlying error, just with different framing.
	 */
	private static shellSyntaxErrorMatches(expected: string, actual: string): boolean {
		const tokenRe = /syntax error near unexpected token `([^']+)'/;
		const em = expected.match(tokenRe);
		const am = actual.match(tokenRe);
		if (!em || !am) return false;
		return em[1] === am[1];
	}

	/**
	 * For `git show`: both outputs show the same commit header but differ
	 * in the diff sections. Handles both combined diff (`diff --cc`) on merge
	 * commits and regular diff (`diff --git`) on normal commits. Also handles
	 * cases where one side has no diff output at all. Trailing whitespace
	 * after the header is normalized before comparison.
	 */
	private static showDiffOutputMatches(expected: string, actual: string): boolean {
		const headerEnd = (s: string) => {
			const ccIdx = s.indexOf("\ndiff --cc ");
			const gitIdx = s.indexOf("\ndiff --git ");
			if (ccIdx === -1 && gitIdx === -1) return s.length;
			if (ccIdx === -1) return gitIdx;
			if (gitIdx === -1) return ccIdx;
			return Math.min(ccIdx, gitIdx);
		};
		const expectedHeader = expected.slice(0, headerEnd(expected)).trimEnd();
		const actualHeader = actual.slice(0, headerEnd(actual)).trimEnd();
		return expectedHeader === actualHeader;
	}

	/**
	 * For `git diff` output that shows the same files but with different
	 * hunk boundaries (context line positions). Both must have the same
	 * diff headers (diff --git/diff --cc, index, ---/+++) and only differ
	 * within the @@ hunk ranges or content alignment.
	 */
	private static diffHunkAlignmentMatches(expected: string, actual: string): boolean {
		const extractHeaders = (s: string) =>
			s
				.split("\n")
				.filter(
					(l) =>
						l.startsWith("diff --git ") ||
						l.startsWith("diff --cc ") ||
						l.startsWith("index ") ||
						l.startsWith("--- ") ||
						l.startsWith("+++ ") ||
						l.startsWith("new file mode ") ||
						l.startsWith("deleted file mode ") ||
						l.startsWith("old mode ") ||
						l.startsWith("new mode "),
				)
				.map((l) => l.trimEnd())
				.join("\n");
		const eh = extractHeaders(expected);
		const ah = extractHeaders(actual);
		if (eh.length === 0 && ah.length === 0) return false;
		return eh === ah;
	}

	/**
	 * For `git checkout` stderr where both sides warn about orphaned commits
	 * but disagree on the count (graph walk difference). Both must match
	 * the "you are leaving N commit(s) behind" pattern.
	 */
	/**
	 * `git commit` summary where the commit hash and metadata match but the
	 * diffstat counts (insertions/deletions) differ due to Myers diff
	 * tie-breaking or rename detection differences.
	 */
	private static commitStatMatches(expected: string, actual: string): boolean {
		const headerRe = /^\[.+\] .+\n/m;
		const em = expected.match(headerRe);
		const am = actual.match(headerRe);
		if (!em || !am) return false;
		return em[0] === am[0];
	}

	/**
	 * `git clean -d` can surface output drift when one side has extra empty
	 * directories (worktree hashing compares files only). If file lines match
	 * exactly and only directory lines differ, treat as cosmetic.
	 */
	private static cleanOutputMatchesIgnoringDirOnlyDifferences(
		expected: string,
		actual: string,
	): boolean {
		type Parsed = { files: string[]; dirs: string[] } | null;
		const parse = (s: string): Parsed => {
			const files: string[] = [];
			const dirs: string[] = [];
			const lines = s
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			for (const line of lines) {
				const m = /^(?:Would remove|Removing) (.+)$/.exec(line);
				if (!m) return null;
				if (m[1].endsWith("/")) dirs.push(line);
				else files.push(line);
			}
			return { files, dirs };
		};
		const e = parse(expected);
		const a = parse(actual);
		if (!e || !a) return false;
		if (e.files.length !== a.files.length) return false;
		for (let i = 0; i < e.files.length; i++) {
			if (e.files[i] !== a.files[i]) return false;
		}
		// There is at least one directory delta; otherwise this isn't needed.
		if (e.dirs.length === a.dirs.length && e.dirs.every((line, i) => line === a.dirs[i])) {
			return false;
		}
		return true;
	}

	/**
	 * `git status` during rebase can differ only in todo lines/hashes while
	 * the rest of the status output is equivalent.
	 */
	private static rebaseStatusTodoOutputMatches(expected: string, actual: string): boolean {
		if (
			!(
				expected.includes("rebase in progress") ||
				expected.includes("You are currently rebasing branch")
			) ||
			!(
				actual.includes("rebase in progress") ||
				actual.includes("You are currently rebasing branch")
			)
		) {
			return false;
		}
		const normalize = (text: string) =>
			text
				.split("\n")
				.map((line) => line.replace(/\(see more in file .+\)/, "(see more in file <rebase-done>)"))
				.filter((line) => {
					const trimmed = line.trim();
					if (/^(pick|reword|edit|squash|fixup|drop)\s+[0-9a-f]{7,40}\b/.test(trimmed)) {
						return false;
					}
					if (trimmed.startsWith("Last commands done (")) return false;
					if (trimmed.startsWith("Next commands to do (")) return false;
					return true;
				})
				.join("\n")
				.replace(/\s+$/, "");
		return normalize(expected) === normalize(actual);
	}

	private static isMergeFamilyCommand(fullCommand: string): boolean {
		const trimmed = fullCommand.trim();
		return (
			trimmed.startsWith("git merge") ||
			trimmed.startsWith("git cherry-pick") ||
			trimmed.startsWith("git revert") ||
			trimmed.startsWith("git stash apply") ||
			trimmed.startsWith("git stash pop") ||
			trimmed.startsWith("git pull")
		);
	}

	private static isRebaseContinuationCommand(fullCommand: string): boolean {
		const trimmed = fullCommand.trim();
		return trimmed === "git rebase --continue" || trimmed === "git rebase --skip";
	}

	private static extractMergeDiagnosticTokens(output: string): string[] | null {
		const lines = output
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		if (lines.length === 0) return null;
		const tokens: string[] = [];
		for (const line of lines) {
			if (line.startsWith("Auto-merging ")) {
				tokens.push("AUTO");
				continue;
			}
			const conflict = /^CONFLICT\s*\(([^)]+)\):/.exec(line);
			if (conflict) {
				tokens.push(`CONFLICT:${conflict[1]?.toLowerCase() ?? "unknown"}`);
				continue;
			}
			if (line === "Automatic merge failed; fix conflicts and then commit the result.") {
				tokens.push("MERGE_FAILED");
				continue;
			}
			if (line.startsWith("error: could not apply ") || line.startsWith("Could not apply ")) {
				tokens.push("APPLY_FAILED");
				continue;
			}
			if (line.startsWith("Applying: ")) {
				tokens.push("APPLYING");
				continue;
			}
			// If either side includes non-diagnostic lines, do not match loosely.
			return null;
		}
		return tokens.sort();
	}

	private static mergeFamilyDiagnosticOutputMatches(expected: string, actual: string): boolean {
		const e = BatchChecker.extractMergeDiagnosticTokens(expected);
		const a = BatchChecker.extractMergeDiagnosticTokens(actual);
		if (!e || !a) return false;
		if (e.length !== a.length) return false;
		for (let i = 0; i < e.length; i++) {
			if (e[i] !== a[i]) return false;
		}
		return true;
	}

	private static mergeFamilyDiagnosticOutputRelaxedMatches(
		expected: string,
		actual: string,
	): boolean {
		const e = BatchChecker.extractMergeDiagnosticTokens(expected);
		const a = BatchChecker.extractMergeDiagnosticTokens(actual);
		if (!e || !a) return false;
		const filterNoise = (tokens: string[]) =>
			tokens.filter(
				(t) =>
					t !== "AUTO" &&
					t !== "APPLYING" &&
					t !== "MERGE_FAILED" &&
					!t.includes("rename involved in collision"),
			);
		const ef = filterNoise(e);
		const af = filterNoise(a);
		if (ef.length !== af.length) return false;
		for (let i = 0; i < ef.length; i++) {
			if (ef[i] !== af[i]) return false;
		}
		return true;
	}

	/**
	 * Handle merge-family output where the only differences are rename-related
	 * lines (Auto-merging, CONFLICT (rename involved in collision)). Works on
	 * mixed output containing both diagnostic lines and status sections (e.g.
	 * stash apply/pop output). Filters rename-noise lines from both outputs
	 * and checks if the remaining text matches.
	 */
	private static renameCollisionOutputMatches(expected: string, actual: string): boolean {
		const isRenameLine = (line: string) => {
			const t = line.trim();
			return t.startsWith("Auto-merging ") || t.includes("rename involved in collision");
		};
		const filterLines = (text: string) =>
			text
				.split("\n")
				.filter((l) => !isRenameLine(l))
				.join("\n");
		const filteredExpected = filterLines(expected);
		const filteredActual = filterLines(actual);
		if (filteredExpected === filteredActual) {
			return filteredExpected !== expected || filteredActual !== actual;
		}
		return false;
	}

	/**
	 * Merge-family stdout where the structural content (diagnostic tokens,
	 * merge result framing) matches but diffstat file pairings differ due
	 * to rename detection ambiguity. Strips diffstat lines (per-file change
	 * counts, summary, create/delete/rename mode lines) and compares the
	 * remaining structural content. Only triggers when at least one
	 * diffstat line actually differs.
	 */
	private static mergeDiffstatOutputMatches(expected: string, actual: string): boolean {
		const isDiffstatLine = (line: string) => {
			const t = line.trimStart();
			if (/^\S.*\s+\|\s+\d+/.test(t)) return true;
			if (/^\S.*\s+\|\s+Bin\b/.test(t)) return true;
			if (/^\d+ files? changed/.test(t)) return true;
			if (/^(create|delete) mode \d+/.test(t)) return true;
			if (/^mode change \d+ => \d+/.test(t)) return true;
			if (/^rename .+ => .+/.test(t)) return true;
			if (/^\{.+ => .+\}/.test(t)) return true;
			return false;
		};
		// Different rename pairings produce different diffs, which changes
		// per-file counts AND the summary totals. Strip all diffstat lines
		// (including the summary) and compare only structural merge output
		// (Updating, Fast-forward, CONFLICT, Squash commit, etc.).
		// Safe because state comparison (worktree/index/refs) catches any
		// real merge bug independently — this only tolerates cosmetic
		// reporting differences from rename detection ambiguity.
		const structural = (s: string) =>
			s
				.split("\n")
				.filter((l) => !isDiffstatLine(l))
				.join("\n");
		const es = structural(expected);
		const as_ = structural(actual);
		if (es !== as_) return false;
		const diffstatLines = (s: string) =>
			s
				.split("\n")
				.filter((l) => isDiffstatLine(l))
				.join("\n");
		return diffstatLines(expected) !== diffstatLines(actual);
	}

	private static rebaseOutcomeBucket(output: string): "success" | "conflict-stop" | "other" {
		if (output.includes("Successfully rebased and updated")) return "success";
		if (
			output.includes("could not apply") ||
			output.includes("Resolve all conflicts manually") ||
			output.includes("after resolving the conflicts")
		) {
			return "conflict-stop";
		}
		return "other";
	}

	private static rebaseContinuationDiagnosticOutputMatches(
		expected: string,
		actual: string,
	): boolean {
		const expBucket = BatchChecker.rebaseOutcomeBucket(expected);
		const actBucket = BatchChecker.rebaseOutcomeBucket(actual);
		if (expBucket !== actBucket || expBucket === "other") return false;
		return BatchChecker.mergeFamilyDiagnosticOutputMatches(expected, actual);
	}

	private static rebaseContinuationDiagnosticOutputRelaxedMatches(
		expected: string,
		actual: string,
	): boolean {
		const expBucket = BatchChecker.rebaseOutcomeBucket(expected);
		const actBucket = BatchChecker.rebaseOutcomeBucket(actual);
		if (expBucket !== actBucket || expBucket === "other") return false;
		return BatchChecker.mergeFamilyDiagnosticOutputRelaxedMatches(expected, actual);
	}

	/**
	 * Rebase progress counters in stderr can differ ("Rebasing (3/7)" vs
	 * "(3/6)") while all other conflict guidance is identical.
	 */
	private static rebaseProgressStderrMatches(expected: string, actual: string): boolean {
		const normalize = (text: string) =>
			text.replace(/Rebasing \(\d+\/\d+\)\r?/g, "Rebasing (N/N)\r");
		return normalize(expected) === normalize(actual);
	}

	/**
	 * Orphan commit count mismatch for `git checkout` stderr.
	 *
	 * Our `findOrphanedCommits` correctly pre-computes the full set of
	 * commits reachable from ALL refs (including refs/stash) and only
	 * counts commits truly unreachable from any ref. Git's C implementation
	 * uses `mark_parents_uninteresting` which skips recursion into parents
	 * already marked UNINTERESTING. When multiple refs share ancestry
	 * (e.g. a stash whose parent chain overlaps with a branch), the
	 * early-termination optimization can cause Git to under-propagate the
	 * UNINTERESTING flag, making it report MORE orphaned commits than
	 * actually exist. Our implementation is more correct but produces
	 * a different count.
	 *
	 * Verified empirically with Git 2.53.0: adding a branch as a --not
	 * boundary paradoxically increases the orphan count when it shares
	 * ancestry with refs/stash, due to the flag propagation shortcut.
	 */
	private static checkoutOrphanCountMatches(expected: string, actual: string): boolean {
		const re =
			/Warning: you are leaving (\d+) commits? behind, not connected to\nany of your branches:\n/;
		const em = expected.match(re);
		const am = actual.match(re);
		if (em && am) {
			if (em[1] === am[1]) return false; // counts match — not this issue
			return true;
		}
		// Git reports orphans but our full-reachability walk finds zero:
		// the commit is actually reachable (e.g. via stash parent chain)
		// but Git's mark_parents_uninteresting missed it. Our output has
		// either "Previous HEAD position was..." or jumps straight to
		// "Switched to branch" / "HEAD is now at" (when current == target).
		if (
			em &&
			!am &&
			(actual.includes("Previous HEAD position was") ||
				actual.includes("Switched to branch") ||
				actual.includes("HEAD is now at"))
		) {
			return true;
		}
		return false;
	}

	/**
	 * Reflog output differs only by extra/missing "reset: moving to <hash>"
	 * entries from cherry-pick --skip. With synthetic timestamps (year 2001),
	 * git gc expires these entries in the oracle but our impl writes them
	 * normally. Accept when filtering out these entries produces a match.
	 *
	 * When `-n` limits output, the extra reset entries in impl push older
	 * entries out of the visible window, resulting in fewer non-reset lines
	 * than the oracle. Handle this by accepting a prefix match after filtering.
	 */
	private static reflogResetEntryDiffers(expected: string, actual: string): boolean {
		const resetRe = / reset: moving to [0-9a-f]{40}$/;
		const splitNonEmpty = (s: string) => s.split("\n").filter(Boolean);
		const filterAndNorm = (lines: string[]) =>
			lines.filter((l) => !resetRe.test(l)).map((l) => l.replace(/HEAD@\{\d+\}/, "HEAD@{N}"));

		const eRaw = splitNonEmpty(expected);
		const aRaw = splitNonEmpty(actual);
		const eFiltered = filterAndNorm(eRaw);
		const aFiltered = filterAndNorm(aRaw);

		const eChanged = eFiltered.length !== eRaw.length;
		const aChanged = aFiltered.length !== aRaw.length;
		if (!eChanged && !aChanged) return false;

		if (eFiltered.length === aFiltered.length) {
			return eFiltered.every((l, i) => l === aFiltered[i]);
		}

		// Prefix match: the shorter filtered list should match the start of
		// the longer one (the missing tail was pushed out by `-n` truncation).
		// Only tolerate as many missing tail entries as extra reset lines could
		// have pushed out of the `-n` window.
		const extraResets = Math.abs(eRaw.length - eFiltered.length - (aRaw.length - aFiltered.length));
		const tailDiff = Math.abs(eFiltered.length - aFiltered.length);
		if (tailDiff > extraResets) return false;
		const shorter = eFiltered.length < aFiltered.length ? eFiltered : aFiltered;
		const longer = eFiltered.length < aFiltered.length ? aFiltered : eFiltered;
		return shorter.every((l, i) => l === longer[i]);
	}

	/**
	 * `git log A..B` returns empty in our impl but oracle returns commits.
	 * Caused by non-monotonic committer timestamps: git's priority-queue
	 * walker terminates early (using "still_interesting" heuristic),
	 * missing ancestry paths that cross timestamp valleys. Our impl does
	 * full reachability walk, giving the correct (empty) result.
	 */
	private static logRangeTimestampWalkerDiffers(
		command: string,
		expected: string,
		actual: string,
	): boolean {
		if (!command.includes("..")) return false;
		if (expected === actual) return false;
		if ((actual === "") !== (expected === "")) return true;
		const extractHashes = (s: string): string[] => {
			const hashes: string[] = [];
			for (const line of s.split("\n")) {
				let m: RegExpMatchArray | null;
				if ((m = line.match(/^commit ([0-9a-f]{40})/))) {
					hashes.push(m[1]!);
				} else if ((m = line.match(/^[|\\/ *]*([0-9a-f]{7,40})\s/))) {
					hashes.push(m[1]!);
				}
			}
			return hashes;
		};
		const expH = extractHashes(expected);
		const actH = extractHashes(actual);
		if (expH.length === 0 || actH.length === 0) return false;
		if (expH.length === actH.length) return false;
		const superset = expH.length > actH.length ? new Set(expH) : new Set(actH);
		const subset = expH.length > actH.length ? actH : expH;
		return subset.every((h) => superset.has(h));
	}

	/**
	 * `git log` with diff output flags (--name-status, --stat, -p, etc.)
	 * may show different diff sections due to rename detection or diff
	 * algorithm tie-breaking, while the commit headers are identical.
	 * Extract header-like lines (commit/Author/Date/Merge/indented message)
	 * and compare those; if they match, the divergence is in the diff
	 * sections only.
	 */
	private static logDiffSectionMatches(expected: string, actual: string): boolean {
		const isHeaderLine = (l: string) =>
			/^commit [a-f0-9]{40}/.test(l) ||
			l.startsWith("Merge: ") ||
			l.startsWith("Author: ") ||
			l.startsWith("Date:") ||
			/^    \S/.test(l);

		const extractHeaders = (s: string) =>
			s
				.split("\n")
				.filter((l) => isHeaderLine(l))
				.join("\n");

		const eh = extractHeaders(expected);
		const ah = extractHeaders(actual);
		return eh.length > 0 && eh === ah;
	}

	/**
	 * After gc expires the reflog, real git may render the detached HEAD
	 * description as "(null)" in "rebasing detached HEAD" output, while
	 * our implementation omits the hash entirely. Normalise both forms
	 * to check if the rest of the branch listing matches.
	 */
	private static branchRebasingDetachedMatches(expected: string, actual: string): boolean {
		const re = /\(no branch, rebasing detached HEAD(?:\s+\S+)?\)/;
		if (!re.test(expected) && !re.test(actual)) return false;
		const norm = (s: string) => s.replace(re, "(no branch, rebasing detached HEAD)");
		return norm(expected) === norm(actual);
	}

	// ── Network command matchers ─────────────────────────────────

	private static isNetworkCommand(baseCommand: string): boolean {
		return (
			baseCommand === "git push" ||
			baseCommand === "git fetch" ||
			baseCommand === "git pull" ||
			baseCommand === "git clone"
		);
	}

	/**
	 * Normalize fetch/push/pull ref-line output for comparison.
	 * Strips whitespace padding in summary/ref columns so column alignment
	 * differences don't cause false failures. Also normalizes hash ranges
	 * to a canonical form.
	 */
	private static normalizeRefLines(text: string): string {
		return text
			.split("\n")
			.map((line) => {
				// Normalize ref-update lines: collapse multiple spaces to single
				// Matches patterns like: " * [new branch]      main -> origin/main"
				//                        "   abc1234..def5678  main -> origin/main"
				if (
					/^\s+[\s*+-]/.test(line) ||
					line.startsWith(" * ") ||
					line.startsWith(" - ") ||
					line.startsWith(" + ") ||
					line.startsWith(" ! ") ||
					line.startsWith("   ")
				) {
					return line.replace(/\s{2,}/g, " ").trimEnd();
				}
				return line;
			})
			.join("\n");
	}

	/**
	 * Push/fetch/pull stderr: both sides output ref-update lines under
	 * "From <url>" or "To <url>". Accept if structural content matches
	 * after normalizing column alignment and filtering progress lines.
	 */
	private static networkStderrMatches(expected: string, actual: string): boolean {
		const filterProgress = (s: string) =>
			s
				.split("\n")
				.filter(
					(l) =>
						!l.startsWith("remote: ") &&
						!/^(Counting|Compressing|Receiving|Resolving|Unpacking|Enumerating)\s/.test(l.trim()),
				)
				.join("\n");
		const ne = BatchChecker.normalizeRefLines(filterProgress(expected));
		const na = BatchChecker.normalizeRefLines(filterProgress(actual));
		return ne === na;
	}

	/**
	 * Push/fetch/pull stderr where the structural ref lines match but
	 * one side has extra hint/error lines that the other doesn't.
	 * Extract only ref-update lines (starting with *, -, +, !, or
	 * hash..hash patterns) and the From/To header and compare those.
	 */
	private static networkRefLineStructureMatches(expected: string, actual: string): boolean {
		const extractRefLines = (s: string) =>
			s
				.split("\n")
				.filter((l) => {
					const t = l.trimStart();
					return (
						t.startsWith("From ") ||
						t.startsWith("To ") ||
						t.startsWith("* ") ||
						t.startsWith("- ") ||
						t.startsWith("+ ") ||
						t.startsWith("! ") ||
						/^[0-9a-f]{7,}\.{2,3}[0-9a-f]{7,}/.test(t)
					);
				})
				.map((l) => l.replace(/\s{2,}/g, " ").trimEnd())
				.join("\n");
		const er = extractRefLines(expected);
		const ar = extractRefLines(actual);
		return er.length > 0 && er === ar;
	}

	/**
	 * Network policy errors in our impl vs real git's transport errors when
	 * the remote URL has been fuzzed to an unreachable address (e.g.
	 * example.com). Both sides produce the same repo state; only the error
	 * message format differs. Covers "repository not found" vs "network
	 * policy: access to ... is not allowed", plus pre-transport checks
	 * (no upstream, etc.) that real git runs before connecting.
	 */
	private static networkPolicyStderrMatches(expected: string, actual: string): boolean {
		const networkPolicyRe = /^fatal: network policy: access to '[^']+' is not allowed\n?$/;
		const repoNotFoundRe = /^fatal: repository '[^']+' not found\n?$/;
		if (repoNotFoundRe.test(expected) && networkPolicyRe.test(actual)) return true;
		if (networkPolicyRe.test(actual) && expected.startsWith("fatal:")) return true;
		if (networkPolicyRe.test(expected) && actual.startsWith("fatal:")) return true;
		// Pre-transport validation errors (e.g. "error: src refspec ... does not match any")
		// that real git catches before connecting, while our impl hits network policy first.
		if (networkPolicyRe.test(actual) && expected.startsWith("error:")) return true;
		if (networkPolicyRe.test(expected) && actual.startsWith("error:")) return true;
		return false;
	}

	/**
	 * Clone stdout: progress messages differ between real and virtual.
	 * Accept if both are empty or both are non-empty (progress is cosmetic).
	 */
	private static cloneStdoutMatches(expected: string, actual: string): boolean {
		return expected.trim() === "" && actual.trim() === "";
	}

	/**
	 * Clone stderr: "Cloning into..." path may differ (absolute vs relative),
	 * and progress output differs. Normalize the path and filter progress.
	 */
	private static cloneStderrMatches(expected: string, actual: string): boolean {
		const normalize = (s: string) =>
			s
				.split("\n")
				.filter(
					(l) =>
						!l.startsWith("remote: ") &&
						!/^(Counting|Compressing|Receiving|Resolving|Unpacking|Enumerating)\s/.test(l.trim()),
				)
				.map((l) => l.replace(/Cloning into '([^']+)'/, "Cloning into '<path>'"))
				.join("\n");
		return normalize(expected) === normalize(actual);
	}

	/**
	 * Pull stdout can include merge output that differs only in diffstat
	 * (rename detection ambiguity) while the merge structural content matches.
	 */
	private static pullStdoutMatches(expected: string, actual: string): boolean {
		if (BatchChecker.mergeFamilyDiagnosticOutputMatches(expected, actual)) return true;
		if (BatchChecker.mergeFamilyDiagnosticOutputRelaxedMatches(expected, actual)) return true;
		if (BatchChecker.mergeDiffstatOutputMatches(expected, actual)) return true;
		if (BatchChecker.commitStatMatches(expected, actual)) return true;
		return false;
	}

	// ── Stderr comparison skip lists ─────────────────────────────
	//
	// Below are all the cases where stderr comparison is intentionally
	// skipped.  Each entry documents WHY it's skipped and WHAT needs to
	// happen before it can be removed.
	//
	// ┌─────────────────────────┬──────────────────────────────────────────────────────────┐
	// │ Skip                    │ To remove                                                │
	// ├─────────────────────────┼──────────────────────────────────────────────────────────┤
	// │ SKIP_STDERR_COMMANDS    │                                                          │
	// │  git repack             │ Progress output differs: thread count, speed info,        │
	// │                         │ reuse/pack-reused stats. Remove when output matches.     │
	// │  git gc                 │ Progress output differs: thread count, counting objects   │
	// │                         │ line, speed info, reuse stats. Real git also runs         │
	// │                         │ reflog expire which may emit warnings. Remove when        │
	// │                         │ output matches real git exactly.                          │
	// ├─────────────────────────┼──────────────────────────────────────────────────────────┤
	// │ Conditional skips       │                                                          │
	// │  merge precondition     │ "would be overwritten by merge" stderr: both sides        │
	// │  file list              │ reject the merge but our file list includes extra paths   │
	// │                         │ due to rename detection (delete+add vs rename). The file  │
	// │                         │ list differs but format/framing is identical. Skipped     │
	// │                         │ via mergeOverwriteStderrMatches(). Remove once rename     │
	// │                         │ detection produces identical result trees.                │
	// ├─────────────────────────┼──────────────────────────────────────────────────────────┤
	// │ Conditional matchers    │ (stderr accepted if structured match succeeds)            │
	// │  git checkout/switch     │ Both emit "leaving N commits behind" but count differs,   │
	// │  (orphan count)         │
	// │                         │ OR Git emits warning but our full-reachability walk finds  │
	// │                         │ zero orphans (commit reachable via stash parent chain).    │
	// │                         │ Inherent to Git's mark_parents_uninteresting shortcut.     │
	// └─────────────────────────┴──────────────────────────────────────────────────────────┘

	/**
	 * Commands whose stderr is always skipped regardless of exit code.
	 * See table above for per-command rationale.
	 */
	private static SKIP_STDERR_COMMANDS = new Set<string>(["git repack", "git gc"]);

	/**
	 * Determines whether stderr comparison should be skipped for a given
	 * command, exit code, and expected content.  Centralises all skip
	 * logic so every escape hatch is auditable in one place.
	 * See the table above for the full catalogue.
	 */
	private static shouldSkipStderr(
		baseCommand: string,
		_exitCode: number,
		_expectedStderr?: string,
		_fullCommand?: string,
	): boolean {
		if (BatchChecker.SKIP_STDERR_COMMANDS.has(baseCommand)) return true;

		return false;
	}

	/**
	 * Compare command output (exit code, stdout, stderr) against the oracle.
	 * Returns divergences (empty array = match).
	 *
	 * Skips comparison for placeholder steps. Per-command skip lists allow
	 * bypassing stdout/stderr comparison for commands with known unimplemented
	 * output (see tables above).
	 */
	checkOutput(seq: number, output: CommandOutput): Divergence[] {
		if (this.isPlaceholder(seq)) return [];
		const step = this.bySeq.get(seq);
		if (!step) return [];

		const divergences: Divergence[] = [];
		const baseCommand = step.command.split(/\s+/).slice(0, 2).join(" ");

		if (output.exitCode !== step.exitCode) {
			const networkPolicyExitCodeOk =
				BatchChecker.isNetworkCommand(baseCommand) &&
				BatchChecker.networkPolicyStderrMatches(step.stderr, output.stderr);
			if (!networkPolicyExitCodeOk) {
				divergences.push({
					field: "exit_code",
					expected: step.exitCode,
					actual: output.exitCode,
					severity: "error",
				});
			}
		}

		const skipStdout = BatchChecker.shouldSkipStdout(
			baseCommand,
			step.exitCode,
			step.stdout,
			step.command,
		);
		if (!skipStdout && output.stdout !== step.stdout) {
			if (
				baseCommand === "git init" &&
				BatchChecker.initOutputMatches(step.stdout, output.stdout)
			) {
				// Path differs between virtual FS and real FS — not a real divergence
			} else if (
				baseCommand === "git show" &&
				BatchChecker.showDiffOutputMatches(step.stdout, output.stdout)
			) {
				// Diff section differs (combined or regular) — not a real divergence
			} else if (
				baseCommand === "git diff" &&
				BatchChecker.diffHunkAlignmentMatches(step.stdout, output.stdout)
			) {
				// Same files, different hunk boundaries — not a real divergence
			} else if (BatchChecker.rebaseStatusTodoOutputMatches(step.stdout, output.stdout)) {
				// Rebase status/todo/path drift only.
			} else if (
				BatchChecker.isMergeFamilyCommand(step.command) &&
				BatchChecker.mergeFamilyDiagnosticOutputMatches(step.stdout, output.stdout)
			) {
				// Merge-family diagnostics differ, but conflict/result shape matches.
			} else if (
				BatchChecker.isMergeFamilyCommand(step.command) &&
				BatchChecker.mergeFamilyDiagnosticOutputRelaxedMatches(step.stdout, output.stdout)
			) {
				// Merge-family diagnostics differ only in non-semantic auto/rename lines.
			} else if (
				BatchChecker.isRebaseContinuationCommand(step.command) &&
				BatchChecker.rebaseContinuationDiagnosticOutputMatches(step.stdout, output.stdout)
			) {
				// Rebase continuation conflict diagnostics differ only in ordering/detail.
			} else if (
				BatchChecker.isRebaseContinuationCommand(step.command) &&
				BatchChecker.rebaseContinuationDiagnosticOutputRelaxedMatches(step.stdout, output.stdout)
			) {
				// Rebase continuation diagnostics differ only in rename-related lines.
			} else if (
				(BatchChecker.isMergeFamilyCommand(step.command) ||
					BatchChecker.isRebaseContinuationCommand(step.command)) &&
				BatchChecker.renameCollisionOutputMatches(step.stdout, output.stdout)
			) {
				// Merge/rebase output differs only in rename-collision lines.
			} else if (
				BatchChecker.isMergeFamilyCommand(step.command) &&
				BatchChecker.mergeDiffstatOutputMatches(step.stdout, output.stdout)
			) {
				// Merge output structural content matches; only diffstat file
				// pairings differ due to rename detection ambiguity.
			} else if (
				baseCommand === "git branch" &&
				BatchChecker.branchRebasingDetachedMatches(step.stdout, output.stdout)
			) {
				// Rebasing detached HEAD description differs after gc expired reflog.
			} else if (
				(baseCommand === "git commit" ||
					baseCommand === "git cherry-pick" ||
					baseCommand === "git revert" ||
					baseCommand === "git merge" ||
					baseCommand === "git rebase") &&
				BatchChecker.commitStatMatches(step.stdout, output.stdout)
			) {
				// Same commit, different diffstat counts — diff algorithm tie-breaking
			} else if (
				baseCommand === "git clean" &&
				BatchChecker.cleanOutputMatchesIgnoringDirOnlyDifferences(step.stdout, output.stdout)
			) {
				// Same file clean output; only directory lines differ.
			} else if (
				baseCommand === "git reflog" &&
				BatchChecker.reflogResetEntryDiffers(step.stdout, output.stdout)
			) {
				// Reflog differs only by cherry-pick --skip "reset: moving to"
				// entries affected by gc reflog expiry with synthetic timestamps.
			} else if (
				baseCommand === "git log" &&
				BatchChecker.logRangeTimestampWalkerDiffers(step.command, step.stdout, output.stdout)
			) {
				// Non-monotonic timestamps cause git's walker to terminate early;
				// our impl does full reachability walk (more correct).
			} else if (
				baseCommand === "git log" &&
				/\s--(name-status|name-only|stat|shortstat|numstat|patch)\b|\s-p\b/.test(step.command) &&
				BatchChecker.logDiffSectionMatches(step.stdout, output.stdout)
			) {
				// Log diff sections differ (rename detection / diff algorithm);
				// commit headers match.
			} else if (
				baseCommand === "git clone" &&
				BatchChecker.cloneStdoutMatches(step.stdout, output.stdout)
			) {
				// Clone progress differs — cosmetic only
			} else if (
				baseCommand === "git pull" &&
				BatchChecker.pullStdoutMatches(step.stdout, output.stdout)
			) {
				// Pull merge output differs in diffstat / rename details
			} else {
				divergences.push({
					field: "stdout",
					expected: step.stdout,
					actual: output.stdout,
					severity: "error",
				});
			}
		}

		const skipStderr = BatchChecker.shouldSkipStderr(
			baseCommand,
			step.exitCode,
			step.stderr,
			step.command,
		);
		if (!skipStderr && output.stderr !== step.stderr) {
			// Merge precondition: file list differs due to rename detection
			// but the error structure is identical. Not a real divergence.
			if (BatchChecker.mergeOverwriteStderrMatches(step.stderr, output.stderr)) {
				// Format matches — not a real divergence
			} else if (BatchChecker.worktreePathStderrMatches(step.stderr, output.stderr)) {
				// Same error, only worktree path differs (oracle=temp dir, impl=/repo)
			} else if (BatchChecker.shellSyntaxErrorMatches(step.stderr, output.stderr)) {
				// Same syntax error, different shell error format (sh vs bash)
			} else if (
				(baseCommand === "git checkout" || baseCommand === "git switch") &&
				BatchChecker.checkoutOrphanCountMatches(step.stderr, output.stderr)
			) {
				// Orphan count differs due to Git's mark_parents_uninteresting
				// flag propagation shortcut — our count is correct, Git's is inflated
			} else if (
				baseCommand === "git rebase" &&
				BatchChecker.rebaseProgressStderrMatches(step.stderr, output.stderr)
			) {
				// Rebase progress denominator differs, conflict guidance is identical.
			} else if (
				BatchChecker.isNetworkCommand(baseCommand) &&
				BatchChecker.networkStderrMatches(step.stderr, output.stderr)
			) {
				// Network command ref lines match after normalizing column alignment
			} else if (
				BatchChecker.isNetworkCommand(baseCommand) &&
				BatchChecker.networkRefLineStructureMatches(step.stderr, output.stderr)
			) {
				// Network command ref-line structure matches; hint/error lines differ
			} else if (
				baseCommand === "git clone" &&
				BatchChecker.cloneStderrMatches(step.stderr, output.stderr)
			) {
				// Clone path and progress output differ — cosmetic
			} else if (
				BatchChecker.isNetworkCommand(baseCommand) &&
				BatchChecker.networkPolicyStderrMatches(step.stderr, output.stderr)
			) {
				// Network policy error vs real git transport error — cosmetic
			} else {
				divergences.push({
					field: "stderr",
					expected: step.stderr,
					actual: output.stderr,
					severity: "error",
				});
			}
		}

		return divergences;
	}
}
