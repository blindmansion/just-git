/**
 * `git am` state machine — owns `.git/rebase-apply/`.
 *
 * Structured like `./rebase.ts` (which owns `.git/rebase-merge/` for
 * `rebase --merge`). Real git shares the `rebase-apply` directory between
 * `git am` and `rebase --apply`; the `applying` marker file is what
 * distinguishes an `am` session from a bare `rebase --apply`.
 *
 * The directory holds the split mailbox (`0001`, `0002`, …), the `next`/`last`
 * counters, the persisted invocation flags (so `--continue` re-derives the
 * original behavior), the pre-`am` HEAD (`orig-head`, for `--abort`), and — on
 * a stop — the current patch's message (`final-commit`) and author env
 * (`author-script`, for `--continue`). No CLI concepts: pure state I/O.
 */
import { parseMail } from "./patch/mailinfo.ts";
import { join } from "./path.ts";
import type { GitContext, Identity } from "./types.ts";

/** Absolute path to the shared `am` / `rebase --apply` state directory. */
export function rebaseApplyDir(ctx: GitContext): string {
	return join(ctx.gitDir, "rebase-apply");
}

function amPath(ctx: GitContext, name: string): string {
	return join(rebaseApplyDir(ctx), name);
}

/** The persisted `am` session state (mirrors real git's `rebase-apply` files). */
export interface AmState {
	/** Current patch index (1-based). */
	next: number;
	/** Total patch count. */
	last: number;
	threeway: boolean;
	sign: boolean;
	keep: boolean;
	scissors: boolean;
	quiet: boolean;
	keepCr: boolean;
	committerDateIsAuthorDate: boolean;
	/** Pre-`am` HEAD, for `--abort`'s safe restore. */
	origHead: string;
}

/** Zero-padded patch file name for message `n` (`1` → `0001`). */
export function patchFileName(n: number): string {
	return String(n).padStart(4, "0");
}

/**
 * Whether an `am` session is in progress: the `applying` marker distinguishes
 * it from a `rebase --apply` that shares the same directory.
 */
export async function isAmInProgress(ctx: GitContext): Promise<boolean> {
	return ctx.fs.exists(amPath(ctx, "applying"));
}

async function writeBoolFile(ctx: GitContext, name: string, value: boolean): Promise<void> {
	await ctx.fs.writeFile(amPath(ctx, name), value ? "1\n" : "0\n");
}

async function readBoolFile(ctx: GitContext, name: string): Promise<boolean> {
	const p = amPath(ctx, name);
	if (!(await ctx.fs.exists(p))) return false;
	return (await ctx.fs.readFile(p)).trim() === "1";
}

/** Read the current `am` state, or null when no session is in progress. */
export async function readAmState(ctx: GitContext): Promise<AmState | null> {
	if (!(await isAmInProgress(ctx))) return null;
	const next = Number.parseInt((await ctx.fs.readFile(amPath(ctx, "next"))).trim(), 10);
	const last = Number.parseInt((await ctx.fs.readFile(amPath(ctx, "last"))).trim(), 10);
	const origHead = (await ctx.fs.exists(amPath(ctx, "orig-head")))
		? (await ctx.fs.readFile(amPath(ctx, "orig-head"))).trim()
		: "";
	return {
		next,
		last,
		threeway: await readBoolFile(ctx, "threeway"),
		sign: await readBoolFile(ctx, "sign"),
		keep: await readBoolFile(ctx, "keep"),
		scissors: await readBoolFile(ctx, "scissors"),
		quiet: await readBoolFile(ctx, "quiet"),
		keepCr: await readBoolFile(ctx, "keepcr"),
		committerDateIsAuthorDate: await readBoolFile(ctx, "committer-date-is-author-date"),
		origHead,
	};
}

/**
 * Create the state directory and write the full initial `am` state: the split
 * mailbox as `0001`..`N`, the counters, the persisted flags, `orig-head`, and
 * the `applying` marker.
 */
export async function writeAmState(
	ctx: GitContext,
	state: AmState,
	messages: string[],
): Promise<void> {
	const dir = rebaseApplyDir(ctx);
	await ctx.fs.mkdir(dir, { recursive: true });

	for (let i = 0; i < messages.length; i++) {
		await ctx.fs.writeFile(amPath(ctx, patchFileName(i + 1)), messages[i] as string);
	}

	await ctx.fs.writeFile(amPath(ctx, "next"), `${state.next}\n`);
	await ctx.fs.writeFile(amPath(ctx, "last"), `${state.last}\n`);
	await writeBoolFile(ctx, "threeway", state.threeway);
	await writeBoolFile(ctx, "sign", state.sign);
	await writeBoolFile(ctx, "keep", state.keep);
	await writeBoolFile(ctx, "scissors", state.scissors);
	await writeBoolFile(ctx, "quiet", state.quiet);
	await writeBoolFile(ctx, "keepcr", state.keepCr);
	await writeBoolFile(ctx, "committer-date-is-author-date", state.committerDateIsAuthorDate);
	await ctx.fs.writeFile(amPath(ctx, "orig-head"), `${state.origHead}\n`);
	await ctx.fs.writeFile(amPath(ctx, "applying"), "");
}

/** Read the raw text of the `n`-th split message. */
export async function readPatchMessage(ctx: GitContext, n: number): Promise<string> {
	return ctx.fs.readFile(amPath(ctx, patchFileName(n)));
}

/**
 * Whether the currently-paused `am` patch is empty (git's `am_empty_patch`,
 * derived from an empty extracted `patch`). Drives the empty-patch variant of
 * the `git status` "am session" advice.
 */
export async function isAmEmptyPatch(ctx: GitContext): Promise<boolean> {
	const state = await readAmState(ctx);
	if (!state || state.next > state.last) return false;
	const raw = await readPatchMessage(ctx, state.next);
	const mail = parseMail(raw, {
		keep: state.keep,
		scissors: state.scissors,
		keepCr: state.keepCr,
	});
	return mail.patchText.trim() === "";
}

/** The metadata a paused patch left behind, replayed by `--continue`. */
export interface AmStopMeta {
	/** The commit message (`final-commit`). */
	message: string;
	/** The author identity recovered from `author-script`. */
	author: Identity;
}

/**
 * Parse an `author-script` (git's `read_author_script`): three single-quoted
 * `GIT_AUTHOR_*` assignments, with the date as `@<epoch> <tz>`.
 */
function parseAuthorScript(script: string): Identity | null {
	const get = (key: string): string | null => {
		const m = new RegExp(`^${key}='(.*)'$`, "m").exec(script);
		return m ? (m[1] as string) : null;
	};
	const name = get("GIT_AUTHOR_NAME");
	const email = get("GIT_AUTHOR_EMAIL");
	if (name === null || email === null) return null;
	const date = get("GIT_AUTHOR_DATE");
	let timestamp = 0;
	let timezone = "+0000";
	const dm = date ? /^@(-?\d+)\s+([+-]\d{4})$/.exec(date.trim()) : null;
	if (dm) {
		timestamp = Number.parseInt(dm[1] as string, 10);
		timezone = dm[2] as string;
	}
	return { name, email, timestamp, timezone };
}

/**
 * Read the paused patch's metadata (`final-commit` + `author-script`) that a
 * stop left behind, for `--continue` to replay. Returns null when the
 * `author-script` is absent (nothing to resume).
 */
export async function readAmStopMeta(ctx: GitContext): Promise<AmStopMeta | null> {
	const scriptPath = amPath(ctx, "author-script");
	if (!(await ctx.fs.exists(scriptPath))) return null;
	const author = parseAuthorScript(await ctx.fs.readFile(scriptPath));
	if (!author) return null;
	const fcPath = amPath(ctx, "final-commit");
	const message = (await ctx.fs.exists(fcPath)) ? await ctx.fs.readFile(fcPath) : "";
	return { message, author };
}

/** Advance the `next` counter on disk (called after each committed patch). */
export async function setAmNext(ctx: GitContext, next: number): Promise<void> {
	await ctx.fs.writeFile(amPath(ctx, "next"), `${next}\n`);
}

/**
 * Persist the paused patch's metadata on a stop: the commit message
 * (`final-commit`) and the author env (`author-script`) that `--continue`
 * replays. Mirrors git's `write_author_script` / `final-commit` files.
 */
export async function writeAmStopMeta(
	ctx: GitContext,
	message: string,
	author: Identity,
): Promise<void> {
	await ctx.fs.writeFile(amPath(ctx, "final-commit"), message);
	const dateStr = `@${author.timestamp} ${author.timezone}`;
	await ctx.fs.writeFile(
		amPath(ctx, "author-script"),
		`GIT_AUTHOR_NAME='${author.name}'\nGIT_AUTHOR_EMAIL='${author.email}'\nGIT_AUTHOR_DATE='${dateStr}'\n`,
	);
}

/** Remove the state directory entirely (session finished or aborted). */
export async function clearAmState(ctx: GitContext): Promise<void> {
	const dir = rebaseApplyDir(ctx);
	if (await ctx.fs.exists(dir)) await ctx.fs.rm(dir, { recursive: true });
}
