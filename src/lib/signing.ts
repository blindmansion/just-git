import { serializeCommit } from "./objects/commit.ts";
import { serializeTag } from "./objects/tag.ts";
import type { Commit, GitRepo, Tag } from "./types.ts";

// ── Capability interfaces ───────────────────────────────────────────

/**
 * Produces an armored signature block for a canonical payload.
 *
 * Injected host capability (mirrors {@link MergeDriver}): just-git stays a
 * pure, sandboxable core and delegates anything that touches private keys,
 * agents, or subprocesses. Returns an ASCII-armored block — e.g.
 * `-----BEGIN PGP SIGNATURE-----` or `-----BEGIN SSH SIGNATURE-----`. The
 * block is self-describing, so the same signer covers commits, annotated
 * tags, and (future) push certificates.
 *
 * In the first cut just-git only ever passes `payload`; the host signer
 * picks its own key. The optional second parameter is a non-breaking seam
 * for future `-S <keyid>` / `user.signingkey` dispatch.
 */
export type Signer = (
	payload: Uint8Array,
	opts?: { keyId?: string; format?: string },
) => string | Promise<string>;

/**
 * Verifies an armored signature against its canonical payload, returning a
 * trust verdict. Deterministic and often implementable in pure TypeScript
 * (e.g. ed25519 via WebCrypto), so a locked-down consumer can verify even
 * when it could never sign. Trust/keyring configuration lives entirely
 * inside the implementation.
 */
export type Verifier = (
	payload: Uint8Array,
	signature: string,
) => VerificationResult | Promise<VerificationResult>;

/**
 * Outcome of a {@link Verifier} call. The `status` vocabulary mirrors git's
 * `%G?` codes so consumers borrow a known trust model rather than inventing
 * one.
 */
export interface VerificationResult {
	/**
	 * - `good` — valid signature from a trusted key
	 * - `bad` — signature does not verify
	 * - `unknown` — valid signature, key validity unknown / untrusted
	 * - `expired` — valid signature from an expired key
	 * - `revoked` — valid signature from a revoked key
	 * - `cannot-check` — verification could not be performed (missing key, etc.)
	 */
	status: "good" | "bad" | "unknown" | "expired" | "revoked" | "cannot-check";
	format: "openpgp" | "ssh" | "x509";
	signer?: { name?: string; email?: string };
	/** Key fingerprint or identifier, when known. */
	keyId?: string;
	signedAt?: Date;
}

// ── Canonicalization (the byte-for-byte sign/verify contract) ───────

/**
 * The exact bytes that a commit signature covers: the commit object text
 * with the `gpgsig` header removed. A signer hashes/signs these bytes; a
 * verifier checks the signature against them. Sign and verify MUST agree on
 * this representation byte-for-byte, so just-git owns the framing (header
 * placement, continuation-line indentation, and the header name) and no
 * consumer reimplements it.
 *
 * just-git is SHA-1 throughout today, so commits emit the `gpgsig` header.
 * If a SHA-256 object path ever lands, only the header name changes
 * (`gpgsig-sha256`) — and that choice stays centralized in serialization.
 */
export function commitSigningPayload(commit: Commit): Uint8Array {
	return serializeCommit({ ...commit, gpgsig: undefined });
}

/**
 * The bytes that an annotated-tag signature covers: the tag object text
 * without the trailing armored signature block. Counterpart to
 * {@link commitSigningPayload}.
 */
export function tagSigningPayload(tag: Tag): Uint8Array {
	return serializeTag({ ...tag, gpgsig: undefined });
}

// ── Resolution helpers ──────────────────────────────────────────────

/** Read an ambient {@link Signer} off a repo handle (set on `GitContext`). */
export function getRepoSigner(repo: GitRepo): Signer | undefined {
	return (repo as { signer?: Signer }).signer;
}

/** Read an ambient {@link Verifier} off a repo handle (set on `GitContext`). */
export function getRepoVerifier(repo: GitRepo): Verifier | undefined {
	return (repo as { verifier?: Verifier }).verifier;
}

/**
 * Error thrown when a signature is required (by policy) but no signer is
 * available. Message mirrors git's `error: gpg failed to sign the data`.
 */
export class SigningError extends Error {
	constructor(message = "gpg failed to sign the data") {
		super(message);
		this.name = "SigningError";
	}
}

/**
 * Resolve the SDK-level signing decision for a writer (`createCommit`,
 * `buildCommit`, `commit`, `createAnnotatedTag`).
 *
 * Policy (`sign`) and mechanism (`signer`) are independent:
 * - `sign === false` → never sign.
 * - `sign === true` → must sign; resolves `signer ?? ctx.signer` and throws
 *   {@link SigningError} if neither is present (no silent unsigned commit).
 * - `sign === undefined` → a concrete per-call `signer` implies signing;
 *   an ambient `ctx.signer` alone does NOT (that is gated by config at the
 *   command layer, not the bare SDK).
 */
export function resolveSdkSigning(
	repo: GitRepo,
	options: { sign?: boolean; signer?: Signer },
): Signer | undefined {
	const ambient = getRepoSigner(repo);
	const shouldSign = options.sign ?? options.signer != null;
	if (!shouldSign) return undefined;
	const signer = options.signer ?? ambient;
	if (!signer) throw new SigningError();
	return signer;
}

/** Sign a commit payload and return the gpgsig block, or `undefined` to skip. */
export async function signCommitPayload(
	commit: Commit,
	signer: Signer | undefined,
): Promise<string | undefined> {
	if (!signer) return undefined;
	return signer(commitSigningPayload(commit));
}

/** Sign a tag payload and return the signature block, or `undefined` to skip. */
export async function signTagPayload(
	tag: Tag,
	signer: Signer | undefined,
): Promise<string | undefined> {
	if (!signer) return undefined;
	return signer(tagSigningPayload(tag));
}
