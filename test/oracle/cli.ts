#!/usr/bin/env bun

import { cmdClean } from "./cli/clean";
import { cmdConflictBlobs } from "./cli/conflict-blobs";
import { cmdDiffFile } from "./cli/diff-file";
import { cmdDiffWorktree } from "./cli/diff-worktree";
import { cmdGenerate } from "./cli/generate";
import { cmdInspect } from "./cli/inspect";
import { cmdPlannerInspect } from "./cli/planner-inspect";
import { cmdProfile } from "./cli/profile";
import { cmdRebuild } from "./cli/rebuild";
import { cmdSize } from "./cli/size";
import { cmdSummary } from "./cli/summary";
import { cmdTest } from "./cli/test";
import { cmdTestAll } from "./cli/test-all";
import { cmdTraceContext } from "./cli/trace-context";
import { cmdValidate } from "./cli/validate";

/**
 * Unified CLI for the oracle testing framework.
 *
 * Subcommands:
 *   generate   Create oracle traces from real git
 *   test       Replay traces against our implementation and compare
 *   inspect    Examine a specific step — shows oracle + impl diff
 *   rebuild    Materialize a real git repo at a specific step
 *   summary    Aggregate WARN/KNOWN/FAIL counts across all test result logs
 *
 * Examples:
 *   bun oracle generate basic --seeds 1-20 --steps 300
 *   bun oracle test basic
 *   bun oracle test basic 5 -v
 *   bun oracle inspect basic 5 42
 *   bun oracle rebuild basic 5 42
 */

const USAGE = `Usage: bun oracle <command> [args]

Commands:
  validate                          Generate + test core & kitchen presets
  generate [path] --seeds <spec>    Create oracle traces from real git
  test [path] [trace]               Replay and compare against oracle
  test-all [path]                   Test datasets recursively in data/[path]/
  profile [path] [trace]            Profile command execution times
  size [path] [trace]               Measure repo size growth over time
  inspect <path> <trace> <step>     Examine a step with oracle + impl diff
  trace-context <path> <trace> <step> [--before N]
                                    Show prior commands around a step
  diff-worktree <path> <trace> <step> [--limit N] [--worktree path]
                                    Diff oracle vs impl worktree paths
  diff-file <dataset> <trace> <step> <file> [--worktree path]
                                    Show first mismatch for one file
  conflict-blobs <dataset> <trace> <step> <file> [--full] [--worktree path]
                                    Show stage 1/2/3 blob details
  rebuild <path> <trace> <step>     Materialize a real git repo at a step
  planner-inspect <path> <trace> <step>
                                    Compare planner output vs real git rev-list
  summary [path]                    Summarize result logs recursively in data/[path]/
  clean                             Remove leftover temp directories

Dataset paths are relative to data/ and may include grouping directories.
Databases are stored at data/<path>/traces.sqlite.

Run any command without arguments for detailed help.`;

if (import.meta.main) {
	const args = process.argv.slice(2);
	const command = args[0];
	const rest = args.slice(1);

	switch (command) {
		case "validate":
			await cmdValidate(rest);
			break;
		case "generate":
			await cmdGenerate(rest);
			break;
		case "test":
			await cmdTest(rest);
			break;
		case "test-all":
			await cmdTestAll(rest);
			break;
		case "inspect":
			await cmdInspect(rest);
			break;
		case "trace-context":
			await cmdTraceContext(rest);
			break;
		case "diff-worktree":
			await cmdDiffWorktree(rest);
			break;
		case "diff-file":
			await cmdDiffFile(rest);
			break;
		case "conflict-blobs":
			await cmdConflictBlobs(rest);
			break;
		case "rebuild":
			await cmdRebuild(rest);
			break;
		case "profile":
			await cmdProfile(rest);
			break;
		case "size":
			await cmdSize(rest);
			break;
		case "planner-inspect":
			await cmdPlannerInspect(rest);
			break;
		case "summary":
			cmdSummary(rest);
			break;
		case "clean":
			await cmdClean(rest);
			break;
		default:
			console.log(USAGE);
			process.exit(command ? 1 : 0);
	}
}
