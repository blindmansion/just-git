#!/usr/bin/env bun
import * as nodeFs from "node:fs/promises";
import { resolve } from "node:path";
import {
	createTreeAccessor,
	diffTrees,
	getChangedFiles,
	listBranches,
	mergeTrees,
	overlayRepo,
	readCommit,
	readHead,
	readonlyRepo,
	revParse,
	walkCommitHistory,
} from "../src/repo/index.ts";
import { durableFileSystemFromNodeFs, findRepo } from "../src/index.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(`Usage: bun scripts/single-repo.ts [path] [ours] [theirs]

Find the repository containing a path and run a safe merge analysis.
The path defaults to the current directory, ours to HEAD, and theirs to main.

Example:
  bun scripts/single-repo.ts
  bun scripts/single-repo.ts ~/code/my-project/src feature main`);
	process.exit(0);
}

const [repoPath, oursRevision = "HEAD", theirsRevision = "main"] = args;

// Turn a path into the GitRepo handle accepted by every just-git/repo helper.
const fs = durableFileSystemFromNodeFs(nodeFs);
const startPath = resolve(repoPath ?? process.cwd());
const context = await findRepo(fs, startPath);
if (!context) throw new Error(`No git repository found from ${JSON.stringify(startPath)}`);

console.log(`Started at:  ${startPath}`);
console.log(`Worktree:    ${context.workTree ?? "(bare repository)"}`);
console.log(`Git dir:     ${context.gitDir}`);
console.log(`Common dir:  ${context.commonDir}`);
console.log(
	`Layout:      ${context.gitDir === context.commonDir ? "single git directory" : "linked worktree"}`,
);

// Protect the real repository, then provide temporary in-memory object/ref
// storage for analyses such as mergeTrees that need to construct result trees.
const repo = overlayRepo(readonlyRepo(context));
const head = await readHead(repo);
const branches = await listBranches(repo);

console.log(`\nHEAD:     ${head.branch ?? "(detached)"} ${shortHash(head.hash)}`);
console.log(`Branches: ${branches.map((branch) => branch.name).join(", ") || "(none)"}`);

if (!head.hash) {
	console.log("The repository has no commits.");
	process.exit(0);
}

console.log("\nRecent commits:");
const recentCommits = [];
for await (const commit of walkCommitHistory(repo, head.hash, { limit: 5 })) {
	recentCommits.push(commit);
	console.log(`${shortHash(commit.hash)} ${firstLine(commit.message)}`);
}

const latest = recentCommits[0];
if (latest) {
	const commit = latest;
	const changed = await getChangedFiles(repo, commit.parents[0] ?? null, commit.hash);

	console.log(`\nFiles changed by ${shortHash(commit.hash)}:`);
	for (const file of changed) {
		console.log(`${file.status.padEnd(8)} ${file.path}`);
	}

	const files = await createTreeAccessor(repo, commit.tree).files();
	const topLevelCounts = new Map<string, number>();
	for (const file of files) {
		const area = file.split("/", 1)[0] ?? file;
		topLevelCounts.set(area, (topLevelCounts.get(area) ?? 0) + 1);
	}
	const busiestAreas = [...topLevelCounts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 8);

	console.log("\nHEAD tree analysis:");
	console.log(`Tracked files:       ${files.length}`);
	console.log(`TypeScript files:    ${files.filter((file) => file.endsWith(".ts")).length}`);
	console.log(`Files under test/:   ${files.filter((file) => file.startsWith("test/")).length}`);
	console.log(`Largest top-level areas:`);
	for (const [area, count] of busiestAreas) {
		console.log(`  ${area.padEnd(20)} ${count}`);
	}
}

const oursHash = await revParse(repo, oursRevision);
const theirsHash = await revParse(repo, theirsRevision);
if (!oursHash) throw new Error(`Could not resolve ours revision ${JSON.stringify(oursRevision)}`);
if (!theirsHash) throw new Error(`Could not resolve theirs revision ${JSON.stringify(theirsRevision)}`);

console.log(
	`\nMerge preview: ${oursRevision} (${shortHash(oursHash)}) <- ${theirsRevision} (${shortHash(theirsHash)})`,
);
const merge = await mergeTrees(repo, oursHash, theirsHash, {
	ours: oursRevision,
	theirs: theirsRevision,
});
console.log(`Result: ${merge.clean ? "clean" : `${merge.conflicts.length} conflict(s)`}`);
for (const conflict of merge.conflicts) {
	console.log(`conflict ${conflict.reason.padEnd(16)} ${conflict.path}`);
}
for (const message of merge.messages) {
	console.log(`note     ${message}`);
}

const oursCommit = await readCommit(repo, oursHash);
const mergeChanges = await diffTrees(repo, oursCommit.tree, merge.treeHash);
console.log(`Files changed by the prospective merge: ${mergeChanges.length}`);
for (const file of mergeChanges.slice(0, 20)) {
	console.log(`${file.status.padEnd(8)} ${file.path}`);
}
if (mergeChanges.length > 20) {
	console.log(`... and ${mergeChanges.length - 20} more`);
}

function shortHash(hash: string | null): string {
	return hash?.slice(0, 7) ?? "(unborn)";
}

function firstLine(message: string): string {
	return message.split("\n", 1)[0] ?? "";
}
