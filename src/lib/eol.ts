import { getConfigValue } from "./config.ts";
import { hashObject, isBinaryBytes, readObject } from "./object-db.ts";
import { lstatSafe, readWorktreeContent } from "./symlink.ts";
import type { GitContext, ObjectId } from "./types.ts";

// ── Line-ending conversion (git's convert.c crlf machinery) ─────────
//
// Real git runs a "clean" conversion (CRLF → LF) when hashing or staging
// worktree content, and a "smudge" conversion (LF → CRLF) when checking
// files out, governed by `core.autocrlf`. Without this, a CRLF worktree
// file never hash-matches its LF blob and every such file shows up as
// perpetually modified (the default state of a Windows checkout).
//
// Scope: `core.autocrlf` only. `.gitattributes` (`text`, `eol`),
// `core.eol`, and `core.safecrlf` are not consulted.

/** Resolved line-ending conversion policy for one command invocation. */
export interface EolPolicy {
	/** Normalize CRLF → LF on checkin and worktree comparison (`autocrlf=true|input`). */
	clean: boolean;
	/** Convert LF → CRLF on checkout (`autocrlf=true` only). */
	smudgeCrlf: boolean;
}

const NO_CONVERSION: EolPolicy = { clean: false, smudgeCrlf: false };

const policyCache = new WeakMap<GitContext, Promise<EolPolicy>>();

/**
 * Resolve `core.autocrlf` into an {@link EolPolicy}, memoized per context.
 * A GitContext lives for one command invocation, so config is read at most
 * once per command rather than once per file.
 *
 * Caveat: contexts from the repo-level helpers (`createWorktree`,
 * `createSandboxWorktree`) can outlive a single operation. A
 * `core.autocrlf` change made through such a long-lived context is not
 * picked up by it — the policy stays cached for the context's lifetime.
 */
export function getEolPolicy(ctx: GitContext): Promise<EolPolicy> {
	let policy = policyCache.get(ctx);
	if (!policy) {
		policy = resolvePolicy(ctx);
		policyCache.set(ctx, policy);
	}
	return policy;
}

async function resolvePolicy(ctx: GitContext): Promise<EolPolicy> {
	const raw = (await getConfigValue(ctx, "core.autocrlf"))?.toLowerCase();
	if (raw === "true" || raw === "yes" || raw === "on" || raw === "1") {
		return { clean: true, smudgeCrlf: true };
	}
	if (raw === "input") return { clean: true, smudgeCrlf: false };
	return NO_CONVERSION;
}

// ── Byte-level conversions ──────────────────────────────────────────

/** Whether the content contains a CRLF pair. */
export function hasCrlf(content: Uint8Array): boolean {
	// indexOf hops between CRs natively, so LF-only content (the common
	// case under autocrlf) is scanned without a per-byte JS loop.
	for (let i = content.indexOf(0x0d); i !== -1; i = content.indexOf(0x0d, i + 1)) {
		if (content[i + 1] === 0x0a) return true;
	}
	return false;
}

/** Whether the content contains any CR byte. */
export function hasCr(content: Uint8Array): boolean {
	return content.indexOf(0x0d) !== -1;
}

/**
 * Clean conversion: strip the CR of every CRLF pair, leaving lone CRs and
 * LFs untouched (git converts only pairs). Returns the input reference
 * unchanged when there is nothing to convert.
 */
export function crlfToLf(content: Uint8Array): Uint8Array {
	if (!hasCrlf(content)) return content;
	const out = new Uint8Array(content.byteLength);
	let n = 0;
	let start = 0;
	for (let i = content.indexOf(0x0d); i !== -1; i = content.indexOf(0x0d, i + 1)) {
		if (content[i + 1] !== 0x0a) continue;
		// Copy up to (excluding) the CR; the LF survives in the next chunk.
		out.set(content.subarray(start, i), n);
		n += i - start;
		start = i + 1;
	}
	out.set(content.subarray(start), n);
	n += content.byteLength - start;
	return out.subarray(0, n);
}

/**
 * Smudge conversion: insert a CR before every LF. Declines (returns the
 * input unchanged) when the content is binary or already contains a CR —
 * git avoids producing mixed or doubled line endings on checkout.
 */
export function lfToCrlf(content: Uint8Array): Uint8Array {
	if (content.indexOf(0x0a) === -1) return content;
	if (hasCr(content) || isBinaryBytes(content)) return content;
	let lfCount = 0;
	for (let i = 0; i < content.byteLength; i++) {
		if (content[i] === 0x0a) lfCount++;
	}
	const out = new Uint8Array(content.byteLength + lfCount);
	let n = 0;
	for (let i = 0; i < content.byteLength; i++) {
		if (content[i] === 0x0a) out[n++] = 0x0d;
		out[n++] = content[i]!;
	}
	return out;
}

// ── Worktree comparison / read helpers ──────────────────────────────

/** Whether the clean conversion applies to this content under the policy. */
function cleanApplies(policy: EolPolicy, content: Uint8Array): boolean {
	return policy.clean && hasCrlf(content) && !isBinaryBytes(content);
}

/**
 * git's renormalization guard: whether the repo-side blob for a path
 * contains a CR. If it does, CRLF is deliberate repo content and the clean
 * conversion is skipped, so such repos don't report phantom modifications
 * (or normalize on checkin) in the other direction.
 */
async function blobHasCr(ctx: GitContext, hash: ObjectId): Promise<boolean> {
	try {
		const raw = await readObject(ctx, hash);
		return raw.type === "blob" && hasCr(raw.content);
	} catch {
		return false;
	}
}

/**
 * Hash worktree content for comparison against a repo-side blob, applying
 * the clean conversion when the policy calls for it.
 *
 * `referenceHash` is the blob this hash will be compared against (the
 * index or tree entry for the path). Conversion is skipped when the raw
 * content already hashes to it, or when that blob contains a CR (the
 * renormalization guard) — the blob is only read on a raw mismatch, so
 * unmodified files cost no extra object read.
 */
export async function cleanedWorktreeHash(
	ctx: GitContext,
	content: Uint8Array,
	referenceHash?: ObjectId,
): Promise<ObjectId> {
	const policy = await getEolPolicy(ctx);
	if (!cleanApplies(policy, content)) return hashObject("blob", content);
	const rawHash = await hashObject("blob", content);
	if (referenceHash !== undefined) {
		if (rawHash === referenceHash) return rawHash;
		if (await blobHasCr(ctx, referenceHash)) return rawHash;
	}
	return hashObject("blob", crlfToLf(content));
}

/**
 * The bytes to store when staging worktree content whose index entry (if
 * any) is `indexBlobHash`: the clean conversion, subject to the
 * renormalization guard.
 */
export async function cleanForCheckin(
	ctx: GitContext,
	content: Uint8Array,
	indexBlobHash?: ObjectId,
): Promise<Uint8Array> {
	const policy = await getEolPolicy(ctx);
	if (!cleanApplies(policy, content)) return content;
	if (indexBlobHash !== undefined && (await blobHasCr(ctx, indexBlobHash))) return content;
	return crlfToLf(content);
}

/**
 * Resolve worktree content to the bytes matching `targetHash`, which must
 * have been produced by {@link cleanedWorktreeHash} for the same content:
 * the raw bytes when they hash to the target, the cleaned bytes otherwise.
 * Used to render diff output consistent with how the delta was selected.
 */
export async function worktreeBytesForHash(
	ctx: GitContext,
	content: Uint8Array,
	targetHash: ObjectId,
): Promise<Uint8Array> {
	const policy = await getEolPolicy(ctx);
	if (!cleanApplies(policy, content)) return content;
	const rawHash = await hashObject("blob", content);
	if (rawHash === targetHash) return content;
	return crlfToLf(content);
}

/**
 * Hash a worktree file or symlink as a blob for comparison against
 * `referenceHash`, applying the clean conversion. Symlink targets are
 * never converted (their "content" is the link target).
 *
 * Used at the worktree comparison sites: status, rm, ls-files, and
 * checkout safety.
 */
export async function hashCleanedWorktreeEntry(
	ctx: GitContext,
	fullPath: string,
	referenceHash?: ObjectId,
): Promise<ObjectId> {
	const st = await lstatSafe(ctx.fs, fullPath);
	if (st.isSymbolicLink) {
		return hashObject("blob", await readWorktreeContent(ctx.fs, fullPath));
	}
	const content = await ctx.fs.readFileBuffer(fullPath);
	return cleanedWorktreeHash(ctx, content, referenceHash);
}
