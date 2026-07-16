/**
 * CLI-agnostic `git format-patch` engine.
 *
 * Resolves a commit range, walks it (skipping merges), and renders one mbox
 * message per commit plus an optional cover letter — returning structured
 * {@link PatchRecord}s (suggested filename + full message text). Knows nothing
 * about argument parsing, `CommandResult`, or where the output goes: the caller
 * decides whether to write `.patch` files or stream an mbox to stdout.
 *
 * The mbox framing itself lives in `./mbox.ts`; this module is the data /
 * orchestration half (range resolution, commit walk, diff + diffstat
 * generation, numbering, cover letter).
 */
import { buildAbbrevResolver } from "../abbrev.ts";
import type { BoundAttributes } from "../attributes/bound-attributes.ts";
import { computeDiffStats } from "../commit-summary.ts";
import { type CommitEntry, walkCommits } from "../commit-walk.ts";
import { formatRFC2822 } from "../date.ts";
import { formatUnifiedDiff } from "../diff/algorithm.ts";
import { formatBinaryPatch } from "../diff/binary-patch.ts";
import {
	boundDiffAttributes,
	type DiffPresentation,
	resolveDiffPresentation,
} from "../diff/driver.ts";
import { detectRenames, type RenamePair } from "../diff/rename-detection.ts";
import { renderDiffStat } from "../diff/stat-format.ts";
import { findAllMergeBases } from "../merge.ts";
import {
	isBinaryBytes,
	peelToCommit,
	readBlobBytes,
	readCommit,
	readObject,
} from "../object-db.ts";
import { parseRangeSyntax } from "../refs/range-syntax.ts";
import { resolveHead } from "../refs/refs.ts";
import { resolveRevisionRepo } from "../refs/rev-parse.ts";
import { firstLine } from "../text-utils.ts";
import { diffTrees } from "../tree-ops.ts";
import type { Commit, GitRepo, Identity, ObjectId, TreeDiffEntry } from "../types.ts";
import { GIT_EMULATED_VERSION } from "../version.ts";
import {
	appendSignoff,
	encodeHeaderWord,
	FORMAT_PATCH_STAT_WIDTH,
	formatPatchMessage,
	headerNeedsEncoding,
	MBOX_SENTINEL_DATE,
	sanitizeSubjectForFilename,
	splitMessage,
} from "./mbox.ts";

/** A single formatted patch (or cover letter): its git filename + mbox text. */
export interface PatchRecord {
	/** git's `NNNN-<slug>.patch` (or `--numbered-files`) name for this record. */
	filename: string;
	/** The complete mbox message, ending at `<signature>\n` (no trailing blank). */
	content: string;
}

/** The full output of {@link formatPatchSeries}. */
export interface FormatPatchResult {
	/** The `[PATCH 0/N]` cover letter, or null when `--cover-letter` is off. */
	cover: PatchRecord | null;
	/** One record per non-merge commit, ordered oldest → newest. */
	patches: PatchRecord[];
}

/** Inputs to {@link formatPatchSeries}. Mirrors git's `format-patch` selectors. */
export interface FormatPatchOptions {
	/** Positional revision args: `<since>`, `<since>..<until>`, or a series root. */
	revisions?: string[];
	/** Treat a lone `<rev>` as the series root (format down from it, no lower bound). */
	root?: boolean;
	/** Limit the number of patches (git's `-<n>`). */
	count?: number;
	/** Force `n/m` sequence numbers in the subject prefix. */
	numbered?: boolean;
	/** Suppress `n/m` sequence numbers even for a multi-patch series. */
	noNumbered?: boolean;
	/** Name files `1`, `2`, … instead of `NNNN-<slug>.patch`. */
	numberedFiles?: boolean;
	/** Append a `Signed-off-by` trailer (requires {@link committer}). */
	signoff?: boolean;
	/** Custom subject prefix in place of `PATCH`. */
	subjectPrefix?: string;
	/** Mark the series as the Nth reroll (`[PATCH vN]`, `vN-` filename prefix). */
	rerollCount?: number;
	/** Use `[RFC PATCH]` instead of `[PATCH]`. */
	rfc?: boolean;
	/** Prepend a `[PATCH 0/N]` cover letter (requires {@link committer}). */
	coverLetter?: boolean;
	/**
	 * Signature footer text (the `-- \n<signature>` value). Defaults to the
	 * emulated git version ({@link GIT_EMULATED_VERSION}), matching git's own
	 * `format-patch` output.
	 */
	signature?: string;
	/**
	 * Sender identity for `Signed-off-by` trailers and the cover letter's
	 * `From:`/`Date:`. Required when {@link signoff} or {@link coverLetter} is set.
	 */
	committer?: Identity;
}

/** Thrown for user-facing selection failures (bad revision, empty selection). */
export class FormatPatchError extends Error {}

/** Git's rev-parse diagnostic for an argument that is neither a revision nor a path. */
function ambiguousArg(arg: string): string {
	return (
		`ambiguous argument '${arg}': unknown revision or path not in the working tree.\n` +
		"Use '--' to separate paths from revisions, like this:\n" +
		"'git <command> [<revision>...] -- [<file>...]'"
	);
}

/**
 * Resolve, walk, and render a format-patch series. Throws {@link FormatPatchError}
 * for bad revisions, a missing HEAD, or an unspecified selection; returns an
 * empty {@link FormatPatchResult.patches} when the range is valid but contains
 * no non-merge commits.
 */
export async function formatPatchSeries(
	repo: GitRepo,
	opts: FormatPatchOptions,
): Promise<FormatPatchResult> {
	const { startHashes, excludeHashes } = await resolveSelection(repo, opts);

	// Walk, drop merges, apply -<n>, order oldest→newest.
	const collected: CommitEntry[] = [];
	for await (const entry of walkCommits(repo, startHashes, { exclude: excludeHashes })) {
		if (entry.commit.parents.length >= 2) continue; // format-patch skips merges
		collected.push(entry);
		if (opts.count !== undefined && collected.length >= opts.count) break;
	}
	const commits = collected.reverse();

	if (commits.length === 0) return { cover: null, patches: [] };

	const signature = opts.signature ?? GIT_EMULATED_VERSION;

	// Numbering / subject prefix.
	const total = commits.length;
	const coverLetter = opts.coverLetter ?? false;
	const numberedSeries = opts.noNumbered ? false : opts.numbered || coverLetter || total > 1;

	let prefix = opts.subjectPrefix ?? "PATCH";
	if (opts.rfc) prefix = `RFC ${prefix}`;
	if (opts.rerollCount !== undefined) prefix = `${prefix} v${opts.rerollCount}`;

	const signoffLine =
		opts.signoff && opts.committer
			? `Signed-off-by: ${opts.committer.name} <${opts.committer.email}>`
			: null;

	const bound = await boundDiffAttributes(repo);

	// Build one mbox message per commit.
	const patches: PatchRecord[] = [];
	for (let idx = 0; idx < commits.length; idx++) {
		const { hash, commit } = commits[idx] as CommitEntry;
		const { subject, body } = splitMessage(commit.message);
		const finalBody = signoffLine ? appendSignoff(subject, body, signoffLine) : body;
		const { diff, diffStat } = await commitPatchBody(repo, commit, bound);

		patches.push({
			filename: patchFileName(subject, idx + 1, opts.numberedFiles ?? false, opts.rerollCount),
			content: formatPatchMessage({
				sha: hash,
				author: commit.author,
				prefix,
				number: numberedSeries ? idx + 1 : null,
				total,
				subject,
				body: finalBody,
				diffStat,
				diff,
				signature,
			}),
		});
	}

	let cover: PatchRecord | null = null;
	if (coverLetter && opts.committer) {
		const tip = commits[commits.length - 1] as CommitEntry;
		const need8bitCte = await seriesNeeds8bitCte(repo, commits);
		cover = {
			filename: coverFileName(opts.numberedFiles ?? false, opts.rerollCount),
			content: buildCoverLetter(
				commits,
				tip,
				opts.committer,
				prefix,
				total,
				signature,
				need8bitCte,
			),
		};
	}

	return { cover, patches };
}

/** Peel a revision to its commit id, or null when it doesn't resolve to a commit. */
async function resolveTip(repo: GitRepo, rev: string): Promise<ObjectId | null> {
	const resolved = await resolveRevisionRepo(repo, rev);
	if (!resolved) return null;
	try {
		return await peelToCommit(repo, resolved);
	} catch {
		return null;
	}
}

/** Translate the revision selectors into walk start/exclude sets (git's range rules). */
async function resolveSelection(
	repo: GitRepo,
	opts: FormatPatchOptions,
): Promise<{ startHashes: ObjectId[]; excludeHashes: ObjectId[] | undefined }> {
	const revisions = opts.revisions ?? [];
	const range = revisions.length === 1 ? parseRangeSyntax(revisions[0] as string) : null;

	if (range) {
		const left = await resolveTip(repo, range.left);
		const right = await resolveTip(repo, range.right);
		// Git parses `A..B` as a single revision argument; when either endpoint
		// fails to resolve it reports the whole token as an ambiguous
		// revision-or-path, not just the failing side.
		if (!left || !right) throw new FormatPatchError(ambiguousArg(revisions[0] as string));
		if (range.type === "two-dot") {
			return { startHashes: [right], excludeHashes: [left] };
		}
		const bases = await findAllMergeBases(repo, left, right);
		return { startHashes: [right], excludeHashes: bases.length > 0 ? bases : undefined };
	}

	const positive = revisions.length === 1 ? (revisions[0] as string) : null;
	if (positive) {
		const tip = await resolveTip(repo, positive);
		if (!tip) throw new FormatPatchError(`bad revision '${positive}'`);
		if (opts.root || opts.count !== undefined) {
			// `--root <rev>` / `-<n> <rev>`: format down from <rev>.
			return { startHashes: [tip], excludeHashes: undefined };
		}
		// `<rev>`: shorthand for <rev>..HEAD.
		return { startHashes: [await requireHeadHash(repo)], excludeHashes: [tip] };
	}

	if (opts.count !== undefined || opts.root) {
		return { startHashes: [await requireHeadHash(repo)], excludeHashes: undefined };
	}

	throw new FormatPatchError(
		"Which commits do you want to format? Provide a <since>, <since>..<until>, or -<n>.",
	);
}

/** Resolve HEAD, throwing the git "no commits yet" error when it is unborn. */
async function requireHeadHash(repo: GitRepo): Promise<ObjectId> {
	const hash = await resolveHead(repo);
	if (!hash) throw new FormatPatchError("your current branch does not have any commits yet");
	return hash;
}

function coverFileName(numberedFiles: boolean, reroll: number | undefined): string {
	if (numberedFiles) return "0";
	const prefix = reroll !== undefined ? `v${reroll}-` : "";
	return `${prefix}0000-cover-letter.patch`;
}

function patchFileName(
	subject: string,
	num: number,
	numberedFiles: boolean,
	reroll: number | undefined,
): string {
	if (numberedFiles) return String(num);
	const slug = sanitizeSubjectForFilename(subject);
	const prefix = reroll !== undefined ? `v${reroll}-` : "";
	return `${prefix}${String(num).padStart(4, "0")}-${slug}.patch`;
}

/**
 * git's `has_non_ascii` scan in `make_cover_letter`: the cover letter carries
 * the MIME `Content-Type`/`Content-Transfer-Encoding: 8bit` block when *any*
 * commit in the series has a non-ASCII byte anywhere in its raw object buffer
 * (author/committer lines, message body, extra headers) — not merely in the
 * shortlog-rendered subject. RFC-2047 encoding of the `From:` line is a
 * separate mechanism and does not itself add the MIME block.
 */
async function seriesNeeds8bitCte(repo: GitRepo, commits: CommitEntry[]): Promise<boolean> {
	for (const { hash } of commits) {
		const raw = await readObject(repo, hash);
		for (const byte of raw.content) {
			if (byte >= 0x80) return true;
		}
	}
	return false;
}

/**
 * Build the `[PATCH 0/N]` cover letter: placeholder subject/blurb, a shortlog
 * of the series grouped by author, and the `-- \n<signature>` footer. Matches
 * git's cover-letter body (no diffstat in current git).
 *
 * `need8bitCte` (from {@link seriesNeeds8bitCte}) gates the MIME header block
 * git emits when the series carries non-ASCII content.
 */
function buildCoverLetter(
	commits: CommitEntry[],
	tip: CommitEntry,
	committer: Identity,
	prefix: string,
	total: number,
	signature: string,
	need8bitCte: boolean,
): string {
	const shortlog = buildShortlog(commits);
	const fromName = headerNeedsEncoding(committer.name)
		? encodeHeaderWord(committer.name)
		: committer.name;

	let out = "";
	out += `From ${tip.hash} ${MBOX_SENTINEL_DATE}\n`;
	out += `From: ${fromName} <${committer.email}>\n`;
	out += `Date: ${formatRFC2822(committer.timestamp, committer.timezone)}\n`;
	// Cover letter is patch 0, zero-padded to the total width like the rest
	// of the series (`[PATCH 00/10]`).
	const coverNumber = "0".padStart(String(total).length, "0");
	out += `Subject: [${prefix} ${coverNumber}/${total}] *** SUBJECT HERE ***\n`;
	if (need8bitCte) {
		out += "MIME-Version: 1.0\n";
		out += "Content-Type: text/plain; charset=UTF-8\n";
		out += "Content-Transfer-Encoding: 8bit\n";
	}
	out += "\n";
	out += "*** BLURB HERE ***\n";
	out += "\n";
	out += shortlog;
	out += "\n";
	out += "-- \n";
	out += `${signature}\n`;
	return out;
}

/** Group series subjects by author name, alphabetically, git shortlog style. */
function buildShortlog(commits: CommitEntry[]): string {
	const groups = new Map<string, { name: string; subjects: string[] }>();
	for (const { commit } of commits) {
		const key = commit.author.name;
		let group = groups.get(key);
		if (!group) {
			group = { name: key, subjects: [] };
			groups.set(key, group);
		}
		group.subjects.push(firstLine(commit.message));
	}

	const sorted = [...groups.values()].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);

	const sections = sorted.map((g) => {
		let section = `${g.name} (${g.subjects.length}):\n`;
		for (const s of g.subjects) section += `  ${s}\n`;
		return section;
	});
	return sections.join("\n");
}

// ── Per-commit diff + diffstat ──────────────────────────────────────

async function commitPatchBody(
	repo: GitRepo,
	commit: Commit,
	bound: BoundAttributes | undefined,
): Promise<{ diff: string; diffStat: string }> {
	const parentTree =
		commit.parents.length === 1
			? (await readCommit(repo, commit.parents[0] as ObjectId)).tree
			: null;

	const rawDiffs = await diffTrees(repo, parentTree, commit.tree);
	const { remaining, renames } = await detectRenames(repo, rawDiffs);

	const diff = await formatPatchDiff(repo, remaining, renames, bound);
	const stats = await computeDiffStats(repo, remaining, renames, bound);
	const diffStat = renderDiffStat(stats, FORMAT_PATCH_STAT_WIDTH);
	return { diff, diffStat };
}

async function formatPatchDiff(
	repo: GitRepo,
	diffs: TreeDiffEntry[],
	renames: RenamePair[],
	bound: BoundAttributes | undefined,
): Promise<string> {
	type DiffItem = { type: "diff"; entry: TreeDiffEntry } | { type: "rename"; entry: RenamePair };
	const allItems: DiffItem[] = [];
	for (const d of diffs) allItems.push({ type: "diff", entry: d });
	for (const r of renames) allItems.push({ type: "rename", entry: r });
	allItems.sort((a, b) => {
		const pathA = a.type === "diff" ? a.entry.path : a.entry.newPath;
		const pathB = b.type === "diff" ? b.entry.path : b.entry.newPath;
		return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
	});

	const abbrevHash = await buildAbbrevResolver(
		repo,
		allItems.flatMap((i) => [i.entry.oldHash, i.entry.newHash].filter((h): h is string => !!h)),
	);

	let output = "";
	for (const item of allItems) {
		if (item.type === "rename") {
			const r = item.entry;
			const oldBytes = r.oldHash ? await readBlobBytes(repo, r.oldHash) : new Uint8Array(0);
			const newBytes = r.newHash ? await readBlobBytes(repo, r.newHash) : new Uint8Array(0);
			const pres = await resolveDiffPresentation(
				bound,
				r.newPath,
				oldBytes,
				r.oldHash,
				newBytes,
				r.newHash,
			);
			output += formatUnifiedDiff({
				path: r.oldPath,
				oldMode: r.oldMode,
				newMode: r.newMode,
				oldHash: r.oldHash,
				newHash: r.newHash,
				abbrevHash,
				renameTo: r.newPath,
				similarity: r.similarity,
				...pres,
				...(await binaryPatchOption(pres, oldBytes, newBytes)),
			});
		} else {
			const d = item.entry;
			const oldBytes = d.oldHash ? await readBlobBytes(repo, d.oldHash) : new Uint8Array(0);
			const newBytes = d.newHash ? await readBlobBytes(repo, d.newHash) : new Uint8Array(0);
			const pres = await resolveDiffPresentation(
				bound,
				d.path,
				oldBytes,
				d.oldHash,
				newBytes,
				d.newHash,
			);
			output += formatUnifiedDiff({
				path: d.path,
				oldMode: d.oldMode,
				newMode: d.newMode,
				oldHash: d.oldHash,
				newHash: d.newHash,
				abbrevHash,
				isNew: d.status === "added",
				isDeleted: d.status === "deleted",
				...pres,
				...(await binaryPatchOption(pres, oldBytes, newBytes)),
			});
		}
	}
	return output;
}

/**
 * Compute the `binaryPatch` option for a file: `git format-patch` implies
 * `--binary`, so a binary blob is emitted as an appliable `GIT binary patch`
 * literal rather than `Binary files … differ`. Binariness honors the diff
 * driver's force flags (from {@link resolveDiffPresentation}) before falling
 * back to git's content sniff on the raw bytes. Returns an empty object for
 * textual files (nothing to spread).
 */
async function binaryPatchOption(
	pres: DiffPresentation,
	oldBytes: Uint8Array,
	newBytes: Uint8Array,
): Promise<{ binaryPatch?: string }> {
	const binary = pres.forceBinary
		? true
		: pres.forceTextual
			? false
			: isBinaryBytes(oldBytes) || isBinaryBytes(newBytes);
	if (!binary) return {};
	return { binaryPatch: await formatBinaryPatch(oldBytes, newBytes) };
}
