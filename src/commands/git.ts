import type { GitCommandName, GitExtensions } from "../git.ts";
import { type Command, a, command } from "../parse/index.ts";
import { generateHelp } from "../parse/help.ts";
import { registerAddCommand } from "./add.ts";
import { registerBisectCommand } from "./bisect.ts";
import { registerBlameCommand } from "./blame.ts";
import { registerBranchCommand } from "./branch.ts";
import { registerCheckoutCommand } from "./checkout.ts";
import { registerCherryPickCommand } from "./cherry-pick.ts";
import { registerCleanCommand } from "./clean.ts";
import { registerCloneCommand } from "./clone.ts";
import { registerCommitCommand } from "./commit.ts";
import { registerConfigCommand } from "./config.ts";
import { registerDiffCommand } from "./diff.ts";
import { registerFetchCommand } from "./fetch.ts";
import { registerGcCommand } from "./gc.ts";
import { registerInitCommand } from "./init.ts";
import { registerLogCommand } from "./log.ts";
import { registerLsFilesCommand } from "./ls-files.ts";
import { registerMergeCommand } from "./merge.ts";
import { registerMvCommand } from "./mv.ts";
import { registerPullCommand } from "./pull.ts";
import { registerPushCommand } from "./push.ts";
import { registerRebaseCommand } from "./rebase.ts";
import { registerReflogCommand } from "./reflog.ts";
import { registerRemoteCommand } from "./remote.ts";
import { registerRepackCommand } from "./repack.ts";
import { registerResetCommand } from "./reset.ts";
import { registerRestoreCommand } from "./restore.ts";
import { registerRevParseCommand } from "./rev-parse.ts";
import { registerRevertCommand } from "./revert.ts";
import { registerRmCommand } from "./rm.ts";
import { registerShowCommand } from "./show.ts";
import { registerStashCommand } from "./stash.ts";
import { registerStatusCommand } from "./status.ts";
import { registerSwitchCommand } from "./switch.ts";
import { registerTagCommand } from "./tag.ts";

/**
 * Real git commands that are not implemented in just-git.
 * Used to produce a specific error message distinguishing
 * "not implemented" from "not a git command".
 */
export const KNOWN_UNIMPLEMENTED_COMMANDS = new Set([
	"am",
	"annotate",
	"apply",
	"archive",
	"bugreport",
	"bundle",
	"cat-file",
	"check-ignore",
	"check-mailmap",
	"check-ref-format",
	"checkout-index",
	"cherry",
	"commit-tree",
	"count-objects",
	"credential",
	"daemon",
	"describe",
	"diff-files",
	"diff-index",
	"diff-tree",
	"difftool",
	"fast-export",
	"fast-import",
	"filter-branch",
	"for-each-ref",
	"format-patch",
	"fsck",
	"hash-object",
	"instaweb",
	"interpret-trailers",
	"log--hierarchical",
	"ls-remote",
	"ls-tree",
	"maintenance",
	"merge-base",
	"merge-tree",
	"mergetool",
	"multi-pack-index",
	"name-rev",
	"notes",
	"pack-objects",
	"pack-refs",
	"patch-id",
	"prune",
	"range-diff",
	"read-tree",
	"receive-pack",
	"replace",
	"request-pull",
	"rerere",
	"rev-list",
	"send-email",
	"send-pack",
	"shortlog",
	"show-branch",
	"show-ref",
	"sparse-checkout",
	"stash--helper",
	"stripspace",
	"submodule",
	"symbolic-ref",
	"unpack-objects",
	"update-index",
	"update-ref",
	"upload-pack",
	"var",
	"verify-commit",
	"verify-pack",
	"verify-tag",
	"whatchanged",
	"worktree",
	"write-tree",
]);

const COMMAND_REGISTRY: Record<GitCommandName, (git: Command, ext?: GitExtensions) => void> = {
	init: (g) => registerInitCommand(g),
	clone: (g, e) => registerCloneCommand(g, e),
	fetch: (g, e) => registerFetchCommand(g, e),
	pull: (g, e) => registerPullCommand(g, e),
	push: (g, e) => registerPushCommand(g, e),
	add: (g, e) => registerAddCommand(g, e),
	blame: (g, e) => registerBlameCommand(g, e),
	commit: (g, e) => registerCommitCommand(g, e),
	status: (g, e) => registerStatusCommand(g, e),
	log: (g, e) => registerLogCommand(g, e),
	branch: (g, e) => registerBranchCommand(g, e),
	tag: (g, e) => registerTagCommand(g, e),
	checkout: (g, e) => registerCheckoutCommand(g, e),
	diff: (g, e) => registerDiffCommand(g, e),
	reset: (g, e) => registerResetCommand(g, e),
	merge: (g, e) => registerMergeCommand(g, e),
	"cherry-pick": (g, e) => registerCherryPickCommand(g, e),
	revert: (g, e) => registerRevertCommand(g, e),
	rebase: (g, e) => registerRebaseCommand(g, e),
	mv: (g, e) => registerMvCommand(g, e),
	rm: (g, e) => registerRmCommand(g, e),
	remote: (g, e) => registerRemoteCommand(g, e),
	config: (g, e) => registerConfigCommand(g, e),
	show: (g, e) => registerShowCommand(g, e),
	stash: (g, e) => registerStashCommand(g, e),
	"rev-parse": (g, e) => registerRevParseCommand(g, e),
	"ls-files": (g, e) => registerLsFilesCommand(g, e),
	clean: (g, e) => registerCleanCommand(g, e),
	switch: (g, e) => registerSwitchCommand(g, e),
	restore: (g, e) => registerRestoreCommand(g, e),
	reflog: (g, e) => registerReflogCommand(g, e),
	repack: (g, e) => registerRepackCommand(g, e),
	gc: (g, e) => registerGcCommand(g, e),
	bisect: (g, e) => registerBisectCommand(g, e),
};

export function createGitCommand(ext?: GitExtensions): Command {
	const git = command("git", {
		description: "Git command",
	});
	for (const register of Object.values(COMMAND_REGISTRY)) {
		register(git, ext);
	}

	git.command("help", {
		description: "Display help information",
		args: [a.string().name("command").describe("Command to get help for").optional()],
		handler: async (args) => {
			const cmdName = args.command as string | undefined;
			if (!cmdName) {
				return { stdout: generateHelp(git), stderr: "", exitCode: 0 };
			}
			const child = git.children.get(cmdName);
			if (child) {
				return { stdout: generateHelp(child), stderr: "", exitCode: 0 };
			}
			return {
				stdout: "",
				stderr: `git: no help available for '${cmdName}'\n`,
				exitCode: 1,
			};
		},
	});

	return git;
}
