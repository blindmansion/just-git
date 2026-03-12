import { ZERO_HASH } from "./hex.ts";
import { getReflogIdentity } from "./identity.ts";
import { join } from "./path.ts";
import { ensureParentDir } from "./repo.ts";
import type { GitContext, ObjectId } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

interface ReflogEntry {
	oldHash: ObjectId;
	newHash: ObjectId;
	name: string;
	email: string;
	timestamp: number;
	tz: string;
	message: string;
}

// ── Paths ───────────────────────────────────────────────────────────

function reflogPath(ctx: GitContext, refName: string): string {
	return join(ctx.gitDir, "logs", refName);
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
	const path = reflogPath(ctx, refName);
	if (!(await ctx.fs.exists(path))) return [];

	const content = await ctx.fs.readFile(path);
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

/**
 * Write a full set of reflog entries, replacing the file.
 * Entries should be in chronological order (oldest first).
 */
export async function writeReflog(
	ctx: GitContext,
	refName: string,
	entries: ReflogEntry[],
): Promise<void> {
	const path = reflogPath(ctx, refName);
	await ensureParentDir(ctx.fs, path);
	if (entries.length === 0) {
		await ctx.fs.writeFile(path, "");
		return;
	}
	const content = `${entries.map(serializeEntry).join("\n")}\n`;
	await ctx.fs.writeFile(path, content);
}

/**
 * Append a single reflog entry to the end of the reflog file.
 */
export async function appendReflog(
	ctx: GitContext,
	refName: string,
	entry: ReflogEntry,
): Promise<void> {
	const path = reflogPath(ctx, refName);
	await ensureParentDir(ctx.fs, path);
	const line = `${serializeEntry(entry)}\n`;

	if (await ctx.fs.exists(path)) {
		const existing = await ctx.fs.readFile(path);
		await ctx.fs.writeFile(path, existing + line);
	} else {
		await ctx.fs.writeFile(path, line);
	}
}

/**
 * Delete a reflog file entirely.
 */
export async function deleteReflog(ctx: GitContext, refName: string): Promise<void> {
	const path = reflogPath(ctx, refName);
	if (await ctx.fs.exists(path)) {
		await ctx.fs.rm(path);
	}
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
	const ident = await getReflogIdentity(ctx, env);
	const entry: ReflogEntry = {
		oldHash: oldHash ?? ZERO_HASH,
		newHash,
		...ident,
		message,
	};
	await appendReflog(ctx, refName, entry);
	if (alsoHead && refName !== "HEAD") {
		await appendReflog(ctx, "HEAD", entry);
	}
}

export { ZERO_HASH } from "./hex.ts";
