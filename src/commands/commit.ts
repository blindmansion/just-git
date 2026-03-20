import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import {
	ensureTrailingNewline,
	err,
	fatal,
	firstLine,
	formatCommitOneLiner,
	isCommandError,
	requireAuthor,
	requireCommitter,
	requireGitContext,
	requireWorkTree,
	stripCommentLines,
} from "../lib/command-utils.ts";
import { formatCommitSummary } from "../lib/commit-summary.ts";
import {
	getStage0Entries,
	hasConflicts,
	readIndex,
	removeEntry,
	writeIndex,
} from "../lib/index.ts";
import { hashObject, readCommit, writeObject } from "../lib/object-db.ts";
import { serializeCommit } from "../lib/objects/commit.ts";
import {
	clearCherryPickState,
	clearMergeState,
	clearRevertState,
	deleteStateFile,
	readStateFile,
} from "../lib/operation-state.ts";
import { join } from "../lib/path.ts";
import { isRebaseInProgress } from "../lib/rebase.ts";
import { logRef } from "../lib/reflog.ts";
import { branchNameFromRef, readHead, resolveHead, resolveRef, updateRef } from "../lib/refs.ts";
import { generateLongFormStatus } from "../lib/status-format.ts";
import { buildTreeFromIndex } from "../lib/tree-ops.ts";
import { diffIndexToWorkTree, stageFile } from "../lib/worktree.ts";
import { type Command, f, o } from "../parse/index.ts";

export function registerCommitCommand(parent: Command, ext?: GitExtensions) {
	parent.command("commit", {
		description: "Record changes to the repository",
		options: {
			message: o.string().alias("m").repeatable().describe("Commit message"),
			file: o.string().alias("F").describe("Read commit message from file ('-' for stdin)"),
			allowEmpty: f().describe("Allow creating an empty commit"),
			amend: f().describe("Amend the previous commit"),
			noEdit: f().describe("Use the previous commit message without editing"),
			all: f().alias("a").describe("Auto-stage modified and deleted tracked files"),
		},
		handler: async (args, ctx) => {
			const messages = args.message as string[];
			if (messages.length > 0 && args.file !== undefined) {
				return fatal("options '-m' and '-F' cannot be used together");
			}

			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// Read the current index
			let index = await readIndex(gitCtx);

			// -a: auto-stage modified and deleted tracked files
			if (args.all) {
				const workTreeError = requireWorkTree(gitCtx);
				if (workTreeError) return workTreeError;
				const diffs = await diffIndexToWorkTree(gitCtx, index);
				for (const diff of diffs) {
					if (diff.status === "modified") {
						const result = await stageFile(gitCtx, index, diff.path);
						index = result.index;
					} else if (diff.status === "deleted") {
						index = removeEntry(index, diff.path);
					}
					// Skip "untracked" — git commit -a only touches tracked files
				}

				// Also handle conflict-only files (stage > 0, no stage 0).
				// These are tracked files that diffIndexToWorkTree skips
				// (they belong in "Unmerged paths" for status, not "Unstaged").
				// But commit -a should stage them to resolve conflicts.
				const stage0Paths = new Set(getStage0Entries(index).map((e) => e.path));
				const conflictOnlyPaths = new Set(
					index.entries.filter((e) => e.stage > 0 && !stage0Paths.has(e.path)).map((e) => e.path),
				);
				for (const path of conflictOnlyPaths) {
					const fullPath = join(gitCtx.workTree as string, path);
					if (await ctx.fs.exists(fullPath)) {
						const result = await stageFile(gitCtx, index, path);
						index = result.index;
					} else {
						index = removeEntry(index, path);
					}
				}

				// Don't write the index yet — real git uses a temporary "next index"
				// for -a and only persists it when the commit succeeds. If the commit
				// fails (nothing to commit, empty, etc.), the original index is preserved.
			}

			// Check for MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, or rebase (in-progress operations)
			const mergeHeadHash = await resolveRef(gitCtx, "MERGE_HEAD");
			const cherryPickHeadHash = await resolveRef(gitCtx, "CHERRY_PICK_HEAD");
			const revertHeadHash = await resolveRef(gitCtx, "REVERT_HEAD");
			const rebaseActive = await isRebaseInProgress(gitCtx);
			const rebaseHeadHash = rebaseActive ? await resolveRef(gitCtx, "REBASE_HEAD") : null;

			const isAmend = args.amend;

			// Resolve HEAD early — needed for both amend guards and normal flow
			const headHash = await resolveHead(gitCtx);

			// --amend guards (checked BEFORE unmerged-files check, matching real git)
			if (isAmend) {
				if (!headHash) {
					return fatal("You have nothing yet to amend.");
				}
				if (mergeHeadHash) {
					return fatal("You are in the middle of a merge -- cannot amend.");
				}
				if (cherryPickHeadHash) {
					return fatal("You are in the middle of a cherry-pick -- cannot amend.");
				}
				// Note: real git does NOT block --amend during revert.
				// Rebase also allows amend (used internally for squash/fixup).
				// Unmerged files check below catches the error if conflicts exist.
			}

			// Check for unresolved merge conflicts (entries with stage > 0)
			if (hasConflicts(index)) {
				// Real git outputs the unmerged file list (short format) to stdout
				const seen = new Set<string>();
				const unmergedLines: string[] = [];
				for (const e of index.entries) {
					if (e.stage > 0 && !seen.has(e.path)) {
						seen.add(e.path);
						unmergedLines.push(`U\t${e.path}`);
					}
				}
				unmergedLines.sort();
				return {
					stdout: unmergedLines.length > 0 ? `${unmergedLines.join("\n")}\n` : "",
					stderr:
						"error: Committing is not possible because you have unmerged files.\n" +
						"hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
						"hint: as appropriate to mark resolution and make a commit.\n" +
						"fatal: Exiting because of an unresolved conflict.\n",
					exitCode: 128,
				};
			}

			// Read the old commit when amending (used for parents, message fallback, author)
			const oldCommit = isAmend && headHash ? await readCommit(gitCtx, headHash) : null;

			// Resolve commit message: -m / -F flags take priority, then amend's old message, then MERGE_MSG
			let messageText: string | undefined = messages.length > 0 ? messages.join("\n\n") : undefined;
			if (messageText !== undefined) {
				messageText = stripCommentLines(messageText);
				if (!messageText) {
					return {
						stdout: "Aborting commit due to empty commit message.\n",
						stderr: "",
						exitCode: 1,
					};
				}
			}
			if (!messageText && args.file !== undefined) {
				if (args.file === "-") {
					messageText = ctx.stdin;
				} else {
					const filePath = args.file.startsWith("/") ? args.file : join(ctx.cwd, args.file);
					if (!(await ctx.fs.exists(filePath))) {
						return fatal(`could not read log file '${args.file}': No such file or directory`);
					}
					const content = await ctx.fs.readFile(filePath);
					messageText = typeof content === "string" ? content : new TextDecoder().decode(content);
				}
				messageText = stripCommentLines(messageText);
				if (!messageText) {
					return {
						stdout: "Aborting commit due to empty commit message.\n",
						stderr: "",
						exitCode: 1,
					};
				}
			}
			if (!messageText && isAmend && oldCommit) {
				messageText = oldCommit.message;
			}
			if (
				!messageText &&
				(mergeHeadHash || cherryPickHeadHash || revertHeadHash || rebaseHeadHash)
			) {
				// Real git's prepare_to_commit() reads SQUASH_MSG first; if
				// present, it takes priority over MERGE_MSG (they're mutually
				// exclusive in git's message source chain).
				const squashMsg = await readStateFile(gitCtx, "SQUASH_MSG");
				if (squashMsg) {
					messageText = stripCommentLines(squashMsg);
				} else {
					const raw = await readStateFile(gitCtx, "MERGE_MSG");
					if (raw !== null) {
						messageText = stripCommentLines(raw);
					}
				}
			}
			if (!messageText) {
				return err("error: must provide a commit message with -m or -F");
			}

			// Build tree from stage-0 entries only
			const stage0Entries = getStage0Entries(index);
			const treeHash = await buildTreeFromIndex(gitCtx, stage0Entries);

			// pre-commit hook
			const rej = await ext?.hooks?.preCommit?.({ repo: gitCtx, index, treeHash });
			if (isRejection(rej)) return err(rej.message ?? "");

			const allowEmpty = args.allowEmpty;

			// Determine the tree to compare against for the "nothing changed" check.
			// For amend: compare against the amended commit's parent's tree.
			// For normal: compare against HEAD's tree.
			let compareTreeHash: string | null = null;
			if (isAmend && oldCommit) {
				const firstParent = oldCommit.parents[0];
				if (firstParent) {
					const parentCommit = await readCommit(gitCtx, firstParent);
					compareTreeHash = parentCommit.tree;
				} else {
					// Amending a root commit — compare against the empty tree
					compareTreeHash = await hashObject("tree", new Uint8Array(0));
				}
			} else if (headHash) {
				compareTreeHash = (await readCommit(gitCtx, headHash)).tree;
			}

			// Check if there are actual changes to commit.
			// Merge commits are always allowed (even with same tree, they
			// record branch join). Other operations (including rebase and
			// cherry-pick) still require content changes unless --allow-empty.
			// When amending a merge commit, also skip — the merge relationship
			// is the value, not just the tree diff.
			const isAmendingMerge = isAmend && oldCommit && oldCommit.parents.length > 1;
			if (!allowEmpty && !mergeHeadHash && !isAmendingMerge) {
				if (!headHash && !isAmend && stage0Entries.length === 0) {
					return {
						stdout: await generateLongFormStatus(gitCtx, {
							fromCommit: true,
							index,
						}),
						stderr: "",
						exitCode: 1,
					};
				}

				if (compareTreeHash !== null && compareTreeHash === treeHash) {
					if (isAmend) {
						// For amend, status compares against HEAD^ (the parent
						// of the commit being amended), not HEAD itself.
						// Also uses noWarn: real git suppresses the normal footer
						// and prints "No changes" instead (via cmd_commit).
						const amendParent = oldCommit?.parents[0] ?? null;
						const statusOut = await generateLongFormStatus(gitCtx, {
							fromCommit: true,
							compareHash: amendParent,
							noWarn: true,
							index,
						});
						return {
							stdout: `${statusOut}No changes\n`,
							stderr:
								"You asked to amend the most recent commit, but doing so would make\n" +
								"it empty. You can repeat your command with --allow-empty, or you can\n" +
								'remove the commit entirely with "git reset HEAD^".\n',
							exitCode: 1,
						};
					}
					// Empty cherry-pick: tree matches HEAD, CHERRY_PICK_HEAD present
					if (cherryPickHeadHash) {
						return {
							stdout: await generateLongFormStatus(gitCtx, {
								fromCommit: true,
								index,
							}),
							stderr:
								"The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\nOtherwise, please use 'git cherry-pick --skip'\n",
							exitCode: 1,
						};
					}
					return {
						stdout: await generateLongFormStatus(gitCtx, {
							fromCommit: true,
							index,
						}),
						stderr: "",
						exitCode: 1,
					};
				}
			}

			// Resolve identities
			let author = await requireAuthor(gitCtx, ctx.env);
			if (isCommandError(author)) return author;
			const committer = await requireCommitter(gitCtx, ctx.env);
			if (isCommandError(committer)) return committer;

			// For amend, unconditionally preserve the original commit's author.
			// Real git always keeps the original author identity during --amend,
			// ignoring GIT_AUTHOR_NAME/EMAIL/DATE env vars. Only --author flag
			// can override (not yet supported).
			if (isAmend && oldCommit) {
				author.name = oldCommit.author.name;
				author.email = oldCommit.author.email;
				author.timestamp = oldCommit.author.timestamp;
				author.timezone = oldCommit.author.timezone;
			}

			// For cherry-pick, preserve the original commit's author
			if (cherryPickHeadHash) {
				const originalCommit = await readCommit(gitCtx, cherryPickHeadHash);
				author = originalCommit.author;
			}

			// Ensure message ends with a newline
			let message = ensureTrailingNewline(messageText);

			// commit-msg hook
			const msgEvent = { repo: gitCtx, message };
			const msgRej = await ext?.hooks?.commitMsg?.(msgEvent);
			if (isRejection(msgRej)) return err(msgRej.message ?? "");
			message = msgEvent.message;

			// Build parents list
			let parents: string[];
			if (isAmend && oldCommit) {
				parents = [...oldCommit.parents];
			} else {
				parents = headHash ? [headHash] : [];
				if (mergeHeadHash) {
					parents.push(mergeHeadHash);
				}
			}

			// Build and write the commit object
			const commitContent = serializeCommit({
				type: "commit",
				tree: treeHash,
				parents,
				author,
				committer,
				message,
			});
			const commitHash = await writeObject(gitCtx, "commit", commitContent);

			// Persist the index now that the commit succeeded.
			// For -a, this writes the staged modifications/deletions.
			// For non -a, this is a no-op (index unchanged) but matches
			// real git's behavior of refreshing the index after commit.
			await writeIndex(gitCtx, index);

			// Advance the current branch (or detached HEAD)
			const head = await readHead(gitCtx);
			if (head && head.type === "symbolic") {
				await updateRef(gitCtx, head.target, commitHash);
			} else {
				await updateRef(gitCtx, "HEAD", commitHash);
			}

			// Reflog
			const subject = firstLine(message);
			let reflogTag: string;
			if (isAmend) reflogTag = "commit (amend)";
			else if (mergeHeadHash) reflogTag = "commit (merge)";
			else if (cherryPickHeadHash) reflogTag = "commit (cherry-pick)";
			else if (!headHash) reflogTag = "commit (initial)";
			else reflogTag = "commit";
			const reflogMsg = `${reflogTag}: ${subject}`;
			const refName = head?.type === "symbolic" ? head.target : "HEAD";
			await logRef(
				gitCtx,
				ctx.env,
				refName,
				headHash,
				commitHash,
				reflogMsg,
				head?.type === "symbolic",
			);

			// Clean up merge state files if this was a merge commit
			if (mergeHeadHash) {
				await clearMergeState(gitCtx);
			}

			// Clean up cherry-pick state files
			if (cherryPickHeadHash) {
				await clearCherryPickState(gitCtx);
			}

			// Clean up revert state files
			if (revertHeadHash) {
				await clearRevertState(gitCtx);
			}

			// During manual commits inside rebase, keep REBASE_HEAD for
			// `git rebase --continue`, but clear MERGE_MSG like real git.
			if (rebaseHeadHash) {
				await deleteStateFile(gitCtx, "MERGE_MSG");
			}

			// Clean up SQUASH_MSG after commit (consumed by message resolution above)
			await deleteStateFile(gitCtx, "SQUASH_MSG");

			// post-commit hook
			await ext?.hooks?.postCommit?.({
				repo: gitCtx,
				hash: commitHash,
				message,
				branch: head?.type === "symbolic" ? branchNameFromRef(head.target) : null,
				parents,
				author,
			});

			// Format output — for amend, diff against the amended commit's parent
			const branchRef = head?.type === "symbolic" ? head.target : null;
			const branchName = branchRef ? branchNameFromRef(branchRef) : "detached HEAD";
			let parentTree: string | null;
			if (isAmend && oldCommit) {
				const firstParent = oldCommit.parents[0];
				parentTree = firstParent ? (await readCommit(gitCtx, firstParent)).tree : null;
			} else {
				parentTree = headHash ? (await readCommit(gitCtx, headHash)).tree : null;
			}

			// Date shown when author date differs from committer date (author_date_is_interesting in git).
			// This happens for cherry-pick (preserves original author), amend (preserves original author),
			// and rebase (replays commits with original author dates).
			const showDate =
				author.timestamp !== committer.timestamp || author.timezone !== committer.timezone;
			const isMerge = parents.length > 1;
			const summary = await formatCommitSummary(
				gitCtx,
				parentTree,
				treeHash,
				author,
				committer,
				showDate,
				isMerge,
			);

			const header = formatCommitOneLiner(
				branchName,
				commitHash,
				messageText,
				parents.length === 0 && !isAmend,
			);
			return {
				stdout: `${header}\n${summary}`,
				stderr: "",
				exitCode: 0,
			};
		},
	});
}

// Commit summary formatting is in lib/commit-summary.ts
