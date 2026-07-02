import type { FileSystem } from "../../fs.ts";
import { ZERO_HASH } from "../hex.ts";
import { getReflogIdentity } from "../identity.ts";
import { join, ensureParentDir } from "../path.ts";
import { isPerWorktreeRef } from "./classify.ts";
import type { GitContext, ObjectId } from "../types.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface ReflogEntry {
	oldHash: ObjectId;
	newHash: ObjectId;
	name: string;
	email: string;
	timestamp: number;
	tz: string;
	message: string;
}

/**
 * The materialized committer-ish identity stamped onto a reflog entry.
 * Produced by {@link getReflogIdentity} (the config/env-backed shell read)
 * and handed to the pure {@link logRefEffects} builder.
 */
export interface ReflogIdentity {
	name: string;
	email: string;
	timestamp: number;
	tz: string;
}

/**
 * A pending change to a ref's reflog, expressed as data instead of a
 * filesystem write. This is the reflog half of the functional-core /
 * imperative-shell split: pure code on a {@link GitRepo} produces
 * `ReflogEffect[]`, and the shell {@link applyReflogEffects applies} them.
 *
 * - `append`  — add one entry to the end of the ref's reflog.
 * - `rewrite` — replace the ref's reflog with this exact set (e.g. expiry).
 * - `delete`  — remove the ref's reflog file entirely.
 */
export type ReflogEffect =
	| { ref: string; append: ReflogEntry }
	| { ref: string; rewrite: ReflogEntry[] }
	| { ref: string; delete: true };

// ── Pure effect builders ────────────────────────────────────────────

/** Build an append effect: add `entry` to the end of `ref`'s reflog. */
export function reflogAppend(ref: string, entry: ReflogEntry): ReflogEffect {
	return { ref, append: entry };
}

/** Build a rewrite effect: replace `ref`'s reflog with `entries`. */
export function reflogRewrite(ref: string, entries: ReflogEntry[]): ReflogEffect {
	return { ref, rewrite: entries };
}

/** Build a delete effect: remove `ref`'s reflog file. */
export function reflogDelete(ref: string): ReflogEffect {
	return { ref, delete: true };
}

/**
 * Pure counterpart to {@link logRef}: given an already-materialized
 * {@link ReflogIdentity}, produce the reflog effect(s) for moving `refName`
 * from `oldHash` to `newHash`. When `alsoHead` is set and `refName` isn't
 * already HEAD, the same entry is also appended to the HEAD reflog.
 */
export function logRefEffects(
	identity: ReflogIdentity,
	refName: string,
	oldHash: ObjectId | null,
	newHash: ObjectId,
	message: string,
	alsoHead = false,
): ReflogEffect[] {
	const entry: ReflogEntry = {
		oldHash: oldHash ?? ZERO_HASH,
		newHash,
		...identity,
		message,
	};
	const effects: ReflogEffect[] = [reflogAppend(refName, entry)];
	if (alsoHead && refName !== "HEAD") effects.push(reflogAppend("HEAD", entry));
	return effects;
}

// ── Paths ───────────────────────────────────────────────────────────

export function reflogPath(ctx: GitContext, refName: string): string {
	// logs/HEAD is per-worktree; logs/refs/* is shared across worktrees.
	const base = isPerWorktreeRef(refName) ? ctx.gitDir : ctx.commonDir;
	return join(base, "logs", refName);
}

// ── Read ────────────────────────────────────────────────────────────

/**
 * Parse a single reflog line into a ReflogEntry.
 *
 * Format: `<old-sha> <new-sha> <name> <email> <timestamp> <tz>\t<message>`
 */
function parseLine(line: string): ReflogEntry | null {
	// Split on tab to separate identity+hashes from message
	const tabIdx = line.indexOf("\t");
	if (tabIdx < 0) return null;

	const meta = line.slice(0, tabIdx);
	const message = line.slice(tabIdx + 1);

	// meta: "<old> <new> <name> <<email>> <timestamp> <tz>"
	const parts = meta.split(" ");
	if (parts.length < 5) return null;

	const oldHash = parts[0];
	const newHash = parts[1];
	if (!oldHash || !newHash) return null;

	// Find the email enclosed in < >
	const emailStart = meta.indexOf("<");
	const emailEnd = meta.indexOf(">", emailStart);
	if (emailStart < 0 || emailEnd < 0) return null;

	const name = meta.slice(oldHash.length + 1 + newHash.length + 1, emailStart).trim();
	const email = meta.slice(emailStart + 1, emailEnd);

	// After the email: " <timestamp> <tz>"
	const afterEmail = meta.slice(emailEnd + 2);
	const spaceIdx = afterEmail.indexOf(" ");
	if (spaceIdx < 0) return null;

	const timestamp = parseInt(afterEmail.slice(0, spaceIdx), 10);
	const tz = afterEmail.slice(spaceIdx + 1);

	return { oldHash, newHash, name, email, timestamp, tz, message };
}

/**
 * Read all reflog entries for a ref.
 * Returns entries in chronological order (oldest first).
 */
export async function readReflog(ctx: GitContext, refName: string): Promise<ReflogEntry[]> {
	return readReflogAt(ctx.fs, reflogPath(ctx, refName));
}

/**
 * Read reflog entries from an explicit file path. Used by callers that walk
 * the logs tree directly and must read the file they found, rather than
 * re-deriving a path from a ref name (which would re-route across the
 * common/private split).
 */
export async function readReflogAt(fs: FileSystem, path: string): Promise<ReflogEntry[]> {
	if (!(await fs.exists(path))) return [];

	const content = await fs.readFile(path);
	if (!content.trim()) return [];

	const entries: ReflogEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line) continue;
		const entry = parseLine(line);
		if (entry) entries.push(entry);
	}
	return entries;
}

// ── Write ───────────────────────────────────────────────────────────

/** Serialize a reflog entry to a single line (without trailing newline). */
function serializeEntry(entry: ReflogEntry): string {
	return `${entry.oldHash} ${entry.newHash} ${entry.name} <${entry.email}> ${entry.timestamp} ${entry.tz}\t${entry.message}`;
}

// ── Filesystem boundary (apply effects) ─────────────────────────────

/**
 * Apply reflog effects to the filesystem, in order. This is the single
 * imperative-shell write boundary for reflogs: pure code builds
 * {@link ReflogEffect}s, this persists them.
 */
export async function applyReflogEffects(ctx: GitContext, effects: ReflogEffect[]): Promise<void> {
	for (const effect of effects) {
		await applyReflogEffect(ctx, effect);
	}
}

async function applyReflogEffect(ctx: GitContext, effect: ReflogEffect): Promise<void> {
	const path = reflogPath(ctx, effect.ref);

	if ("delete" in effect) {
		if (await ctx.fs.exists(path)) await ctx.fs.rm(path);
		return;
	}

	if ("rewrite" in effect) {
		await ensureParentDir(ctx.fs, path);
		if (effect.rewrite.length === 0) {
			await ctx.fs.writeFile(path, "");
			return;
		}
		await ctx.fs.writeFile(path, `${effect.rewrite.map(serializeEntry).join("\n")}\n`);
		return;
	}

	await ensureParentDir(ctx.fs, path);
	const line = `${serializeEntry(effect.append)}\n`;
	if (await ctx.fs.exists(path)) {
		const existing = await ctx.fs.readFile(path);
		await ctx.fs.writeFile(path, existing + line);
	} else {
		await ctx.fs.writeFile(path, line);
	}
}

// ── Write (imperative-shell wrappers over the effect applier) ────────

/**
 * Write a full set of reflog entries, replacing the file.
 * Entries should be in chronological order (oldest first).
 */
export async function writeReflog(
	ctx: GitContext,
	refName: string,
	entries: ReflogEntry[],
): Promise<void> {
	await applyReflogEffects(ctx, [reflogRewrite(refName, entries)]);
}

/** Write reflog entries to an explicit file path. Counterpart of {@link readReflogAt}. */
export async function writeReflogAt(
	fs: FileSystem,
	path: string,
	entries: ReflogEntry[],
): Promise<void> {
	await ensureParentDir(fs, path);
	if (entries.length === 0) {
		await fs.writeFile(path, "");
		return;
	}
	await fs.writeFile(path, `${entries.map(serializeEntry).join("\n")}\n`);
}

/**
 * Append a single reflog entry to the end of the reflog file.
 */
export async function appendReflog(
	ctx: GitContext,
	refName: string,
	entry: ReflogEntry,
): Promise<void> {
	await applyReflogEffects(ctx, [reflogAppend(refName, entry)]);
}

/**
 * Delete a reflog file entirely.
 */
export async function deleteReflog(ctx: GitContext, refName: string): Promise<void> {
	await applyReflogEffects(ctx, [reflogDelete(refName)]);
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Convenience wrapper: resolves identity and appends a reflog entry in one call.
 * Writes to both `refName` and, when `alsoHead` is true and `refName !== "HEAD"`,
 * writes the same entry to the HEAD reflog.
 */
export async function logRef(
	ctx: GitContext,
	env: Map<string, string>,
	refName: string,
	oldHash: ObjectId | null,
	newHash: ObjectId,
	message: string,
	alsoHead = false,
): Promise<void> {
	const identity = await getReflogIdentity(ctx, env);
	await applyReflogEffects(
		ctx,
		logRefEffects(identity, refName, oldHash, newHash, message, alsoHead),
	);
}

export { ZERO_HASH } from "../hex.ts";
