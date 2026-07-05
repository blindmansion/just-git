import type {
	LongStatusData,
	RebaseStatusView,
	RebaseTodoView,
	TrackingInfo,
} from "../../../lib/status-format.ts";

/**
 * Format tracking info for `git status` / `git checkout` long-form display.
 * Returns multi-line output like:
 *   "Your branch is up to date with 'origin/main'.\n"
 *   "Your branch is ahead of 'origin/main' by 3 commits.\n  (use ...)\n"
 *
 * @param opts.abbreviated - When true, omits the hint for the diverged
 *   case. Real git uses abbreviated tracking in `cmd_commit` (nothing to
 *   commit path) which suppresses the diverged hint but keeps ahead/behind.
 */
export function formatLongTrackingInfo(
	info: TrackingInfo,
	opts?: { abbreviated?: boolean },
): string {
	if (info.gone) {
		return `Your branch is based on '${info.upstream}', but the upstream is gone.\n  (use "git branch --unset-upstream" to fixup)\n`;
	}
	if (info.ahead === 0 && info.behind === 0) {
		return `Your branch is up to date with '${info.upstream}'.\n`;
	}
	if (info.ahead > 0 && info.behind === 0) {
		const plural = info.ahead === 1 ? "commit" : "commits";
		return (
			`Your branch is ahead of '${info.upstream}' by ${info.ahead} ${plural}.\n` +
			`  (use "git push" to publish your local commits)\n`
		);
	}
	if (info.behind > 0 && info.ahead === 0) {
		const plural = info.behind === 1 ? "commit" : "commits";
		return (
			`Your branch is behind '${info.upstream}' by ${info.behind} ${plural}, and can be fast-forwarded.\n` +
			`  (use "git pull" to update your local branch)\n`
		);
	}
	const header =
		`Your branch and '${info.upstream}' have diverged,\n` +
		`and have ${info.ahead} and ${info.behind} different commits each, respectively.\n`;
	if (opts?.abbreviated) return header;
	return header + `  (use "git pull" if you want to integrate the remote branch with yours)\n`;
}

function formatStatusEntry(status: string, path: string, displayPath?: string): string {
	const label = `${status}:`;
	return label.padEnd(12) + (displayPath ?? path);
}

function formatMergeStatusEntry(status: string, path: string): string {
	const label = `${status}:`;
	return label.padEnd(17) + path;
}

function pushRebaseTodoLines(lines: string[], rebase: RebaseStatusView): void {
	const todoLine = (e: RebaseTodoView): string =>
		`   pick ${e.shortHash} # ${e.subject}${e.empty ? " # empty" : ""}`;
	if (rebase.doneCount > 0) {
		const n = rebase.doneCount;
		lines.push(`Last command${n === 1 ? "" : "s"} done (${n} command${n === 1 ? "" : "s"} done):`);
		for (const e of rebase.doneTail) {
			lines.push(todoLine(e));
		}
		if (n > 2) {
			lines.push("  (see more in file .git/rebase-merge/done)");
		}
	}
	if (rebase.todoCount > 0) {
		const n = rebase.todoCount;
		lines.push(
			`Next command${n === 1 ? "" : "s"} to do (${n} remaining command${n === 1 ? "" : "s"}):`,
		);
		for (const e of rebase.todoHead) {
			lines.push(todoLine(e));
		}
		lines.push('  (use "git rebase --edit-todo" to view and edit)');
	} else {
		lines.push("No commands remaining.");
	}
}

/**
 * Render the full long-form `git status` output from pre-gathered data.
 * Pure and synchronous — all I/O happens in `lib/status-format#gatherLongStatus`.
 */
export function renderLongStatus(data: LongStatusData): string {
	const lines: string[] = [];
	const {
		headHash,
		isDetached,
		branchName,
		staged,
		unstaged,
		unmerged,
		collapsedUntracked,
		rebase,
		cherryPickShort,
		revertShort,
		hasMergeHead,
		fromCommit,
		noWarn,
	} = data;
	const showInitial = data.isInitial;
	const whenceIsCommit = !cherryPickShort && !hasMergeHead;

	let hasIntermediateState = false;

	// Branch header line
	if (isDetached && rebase) {
		lines.push(`interactive rebase in progress; onto ${rebase.ontoShort}`);
	} else if (isDetached) {
		if (data.detachPointShort) {
			const atOrFrom = data.detachedAt ? "at" : "from";
			lines.push(`HEAD detached ${atOrFrom} ${data.detachPointShort}`);
		} else {
			lines.push("Not currently on any branch.");
		}
	} else {
		lines.push(`On branch ${branchName}`);
	}

	// Tracking info (only for non-detached, non-rebase, non-initial states;
	// the gatherer leaves `tracking` null otherwise).
	if (data.tracking) {
		const trackingText = formatLongTrackingInfo(data.tracking, { abbreviated: fromCommit });
		for (const tl of trackingText.trimEnd().split("\n")) {
			lines.push(tl);
		}
		hasIntermediateState = true;
	}

	// In-progress operation indicators
	// Real git prints a blank line between tracking info and operation-state
	// sections (e.g. during cherry-pick/rebase) in long status output.
	if (
		hasIntermediateState &&
		(data.amInProgress || rebase || cherryPickShort || revertShort || hasMergeHead)
	) {
		lines.push("");
	}
	if (data.amInProgress) {
		lines.push("You are in the middle of an am session.");
		lines.push('  (fix conflicts and then run "git am --continue")');
		lines.push('  (use "git am --skip" to skip this patch)');
		lines.push('  (use "git am --abort" to restore the original branch)');
		hasIntermediateState = true;
	} else if (rebase && hasMergeHead) {
		pushRebaseTodoLines(lines, rebase);
		lines.push("");
		if (unmerged.length > 0) {
			lines.push("You have unmerged paths.");
			lines.push('  (fix conflicts and run "git commit")');
			lines.push('  (use "git merge --abort" to abort the merge)');
		} else {
			lines.push("All conflicts fixed but you are still merging.");
			lines.push('  (use "git commit" to conclude merge)');
		}
		hasIntermediateState = true;
	} else if (rebase) {
		const hasUnmerged = data.indexHasConflicts;

		pushRebaseTodoLines(lines, rebase);

		const branchSuffix = rebase.origBranch
			? ` branch '${rebase.origBranch}' on '${rebase.ontoShort}'`
			: "";

		if (hasUnmerged) {
			lines.push(`You are currently rebasing${branchSuffix}.`);
			lines.push('  (fix conflicts and then run "git rebase --continue")');
			lines.push('  (use "git rebase --skip" to skip this patch)');
			lines.push('  (use "git rebase --abort" to check out the original branch)');
		} else if (rebase.hasMergeMsg) {
			lines.push(`You are currently rebasing${branchSuffix}.`);
			lines.push('  (all conflicts fixed: run "git rebase --continue")');
		} else {
			const editMsg = branchSuffix
				? `You are currently editing a commit while rebasing${branchSuffix}.`
				: "You are currently editing a commit during a rebase.";
			lines.push(editMsg);
			lines.push('  (use "git commit --amend" to amend the current commit)');
			lines.push('  (use "git rebase --continue" once you are satisfied with your changes)');
		}

		hasIntermediateState = true;
	} else {
		if (cherryPickShort) {
			lines.push(`You are currently cherry-picking commit ${cherryPickShort}.`);
			if (unmerged.length > 0) {
				lines.push('  (fix conflicts and run "git cherry-pick --continue")');
			} else {
				lines.push('  (all conflicts fixed: run "git cherry-pick --continue")');
			}
			lines.push('  (use "git cherry-pick --skip" to skip this patch)');
			lines.push('  (use "git cherry-pick --abort" to cancel the cherry-pick operation)');
			hasIntermediateState = true;
		} else if (revertShort) {
			lines.push(`You are currently reverting commit ${revertShort}.`);
			if (unmerged.length > 0) {
				lines.push('  (fix conflicts and run "git revert --continue")');
			} else {
				lines.push('  (all conflicts fixed: run "git revert --continue")');
			}
			lines.push('  (use "git revert --skip" to skip this patch)');
			lines.push('  (use "git revert --abort" to cancel the revert operation)');
			hasIntermediateState = true;
		} else if (hasMergeHead) {
			if (unmerged.length > 0) {
				lines.push("You have unmerged paths.");
				lines.push('  (fix conflicts and run "git commit")');
				lines.push('  (use "git merge --abort" to abort the merge)');
			} else {
				lines.push("All conflicts fixed but you are still merging.");
				lines.push('  (use "git commit" to conclude merge)');
			}
			hasIntermediateState = true;
		}
	}

	if (data.bisectStartRef !== null) {
		lines.push(`You are currently bisecting, started from branch '${data.bisectStartRef}'.`);
		lines.push('  (use "git bisect reset" to get back to the original branch)');
		hasIntermediateState = true;
	}

	if (showInitial) {
		lines.push("");
		lines.push(fromCommit ? "Initial commit" : "No commits yet");
		hasIntermediateState = true;
	}

	let unstageHint: string | null = null;
	if (whenceIsCommit) {
		unstageHint = headHash
			? '  (use "git restore --staged <file>..." to unstage)'
			: '  (use "git rm --cached <file>..." to unstage)';
	}

	const hasUnstagedDeletions = unstaged.some((e) => e.status === "deleted");
	const addHint = hasUnstagedDeletions
		? '  (use "git add/rm <file>..." to update what will be committed)'
		: '  (use "git add <file>..." to update what will be committed)';

	let hasSections = false;

	if (staged.length > 0) {
		if (hasIntermediateState) lines.push("");
		lines.push("Changes to be committed:");
		if (unstageHint) lines.push(unstageHint);
		for (const entry of staged) {
			lines.push(`\t${formatStatusEntry(entry.status, entry.path, entry.displayPath)}`);
		}
		lines.push("");
		hasSections = true;
	}

	if (unmerged.length > 0) {
		if (!hasSections && hasIntermediateState) lines.push("");
		lines.push("Unmerged paths:");
		if (whenceIsCommit) {
			if (headHash) {
				lines.push('  (use "git restore --staged <file>..." to unstage)');
			} else {
				lines.push('  (use "git rm --cached <file>..." to unstage)');
			}
		}
		const hasDeleteConflicts = unmerged.some(
			(e) =>
				e.status === "deleted by us" ||
				e.status === "deleted by them" ||
				e.status === "both deleted",
		);
		if (hasDeleteConflicts) {
			lines.push('  (use "git add/rm <file>..." as appropriate to mark resolution)');
		} else {
			lines.push('  (use "git add <file>..." to mark resolution)');
		}
		for (const entry of unmerged) {
			lines.push(`\t${formatMergeStatusEntry(entry.status, entry.path)}`);
		}
		lines.push("");
		hasSections = true;
	}

	if (unstaged.length > 0) {
		if (!hasSections && hasIntermediateState) lines.push("");
		lines.push("Changes not staged for commit:");
		lines.push(addHint);
		lines.push('  (use "git restore <file>..." to discard changes in working directory)');
		for (const entry of unstaged) {
			lines.push(`\t${formatStatusEntry(entry.status, entry.path)}`);
		}
		lines.push("");
		hasSections = true;
	}

	if (collapsedUntracked.length > 0) {
		if (!hasSections && hasIntermediateState) lines.push("");
		lines.push("Untracked files:");
		lines.push('  (use "git add <file>..." to include in what will be committed)');
		for (const path of collapsedUntracked) {
			lines.push(`\t${path}`);
		}
		lines.push("");
		hasSections = true;
	}

	const commitable = staged.length > 0 || (hasMergeHead && unmerged.length === 0);
	if (!hasSections && hasIntermediateState && (noWarn || commitable)) {
		lines.push("");
	}
	if (!commitable && !noWarn) {
		if (
			!hasSections &&
			hasIntermediateState &&
			unstaged.length === 0 &&
			unmerged.length === 0 &&
			collapsedUntracked.length === 0
		) {
			lines.push("");
		}
		if (unstaged.length > 0 || unmerged.length > 0) {
			lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
		} else if (collapsedUntracked.length > 0) {
			lines.push('nothing added to commit but untracked files present (use "git add" to track)');
		} else if (showInitial) {
			lines.push('nothing to commit (create/copy files and use "git add" to track)');
		} else {
			lines.push("nothing to commit, working tree clean");
		}
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Format tracking info for `git branch -v`/`-vv` display.
 * Returns bracketed format like `[origin/main: ahead 2, behind 1]`.
 */
export function formatBranchTrackingInfo(info: TrackingInfo, showUpstream: boolean): string {
	if (showUpstream) {
		if (info.gone) return `[${info.upstream}: gone]`;
		if (info.ahead === 0 && info.behind === 0) return `[${info.upstream}]`;
		const parts: string[] = [];
		if (info.ahead > 0) parts.push(`ahead ${info.ahead}`);
		if (info.behind > 0) parts.push(`behind ${info.behind}`);
		return `[${info.upstream}: ${parts.join(", ")}]`;
	}
	if (info.gone) return `[gone]`;
	if (info.ahead === 0 && info.behind === 0) return "";
	const parts: string[] = [];
	if (info.ahead > 0) parts.push(`ahead ${info.ahead}`);
	if (info.behind > 0) parts.push(`behind ${info.behind}`);
	return `[${parts.join(", ")}]`;
}
