import { serializeCommit } from "./objects/commit.ts";
import { serializeTag } from "./objects/tag.ts";
import type { Commit, ConfigView, GitRepo, Tag } from "./types.ts";
import { readConfigView } from "./config/view.ts";
import { configBool } from "./config/parse.ts";

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
 * The command layer resolves git's key selection and forwards it via `opts`:
 * `keyId` is the explicit key (`tag -u <keyid>`) or `user.signingkey`, and
 * `format` is `gpg.format`. A single-key backend can ignore both and pick its
 * own key; a multi-key / multi-format backend acts on them. The values are
 * policy only — just-git never sees the secret itself.
 */
export type Signer = (
	payload: Uint8Array,
	opts?: { keyId?: string; format?: SignatureFormat },
) => string | Promise<string>;

/**
 * Signature backend, mirroring git's `gpg.format` values. Shared by the
 * write side ({@link Signer} `opts.format`) and the read side
 * ({@link VerificationResult.format}) so both halves speak one closed
 * vocabulary — narrowing a free-form `string` to this set later would be a
 * breaking change, so it is fixed up front.
 */
export type SignatureFormat = "openpgp" | "ssh" | "x509";

/**
 * Verifies an armored signature against its canonical payload, returning a
 * trust verdict. Deterministic and often implementable in pure TypeScript
 * (e.g. ed25519 via WebCrypto), so a locked-down consumer can verify even
 * when it could never sign.
 *
 * The command layer forwards git's resolved verify policy via `opts`,
 * symmetric with {@link Signer}: `format` is `gpg.format`, and
 * `allowedSigners` is the `gpg.ssh.allowedSignersFile` selector. Both are
 * policy only — a path or inline text, opaque to just-git exactly like the
 * signer's `keyId` (the trust material itself is loaded by the backend, never
 * read by the core). A backend with its own fixed trust set can ignore both.
 */
export type Verifier = (
	payload: Uint8Array,
	signature: string,
	opts?: VerifierOptions,
) => VerificationResult | Promise<VerificationResult>;

/**
 * Git's resolved verify policy, forwarded to a {@link Verifier}. The read-side
 * counterpart to the {@link Signer} `opts`; see {@link Verifier} for how the
 * values are sourced.
 */
export interface VerifierOptions {
	/** `gpg.format`, when set. A hint only — the armor is self-describing. */
	format?: SignatureFormat;
	/**
	 * The `gpg.ssh.allowedSignersFile` trust-root selector (a VFS path or
	 * inline `allowed_signers` text). Opaque to just-git — the backend decides
	 * how to load and interpret it.
	 */
	allowedSigners?: string;
}

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
	format: SignatureFormat;
	signer?: { name?: string; email?: string };
	/** Key fingerprint or identifier, when known. */
	keyId?: string;
	signedAt?: Date;
}

/**
 * The signing/verification capability pair, injected via
 * `createGit({ signing })` and carried ambiently on a {@link GitRepo} (and
 * thus every {@link GitContext}). Grouping the two halves under one member
 * keeps the repo handle's top-level surface stable: the handle mirrors the
 * `createGit` input shape instead of spreading into loose fields.
 *
 * Both halves are independent and optional — a locked-down consumer can
 * supply only a {@link Verifier} (verify without the authority to sign), or
 * only a {@link Signer}.
 */
export interface SigningCapability {
	/** Write side: turns a canonical payload into an armored signature block. */
	signer?: Signer;
	/** Read side: turns a payload + signature into a trust verdict. */
	verifier?: Verifier;
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

/** Read the ambient {@link Signer} off a handle's capabilities. */
export function getRepoSigner(repo: GitRepo): Signer | undefined {
	return repo.capabilities?.signing?.signer;
}

/** Read the ambient {@link Verifier} off a handle's capabilities. */
export function getRepoVerifier(repo: GitRepo): Verifier | undefined {
	return repo.capabilities?.signing?.verifier;
}

/** Narrow a raw `gpg.format` config value to the known backend set. */
export function asSignatureFormat(value: string | undefined): SignatureFormat | undefined {
	return value === "openpgp" || value === "ssh" || value === "x509" ? value : undefined;
}

/**
 * Resolve the verify policy git would apply, for forwarding to a
 * {@link Verifier} via its `opts`. The read-side mirror of the signer
 * resolution in `resolveCommandSigner`: core reads the *selectors* from config
 * and hands them over, never the trust material itself.
 *
 * Reads `gpg.format` and `gpg.ssh.allowedSignersFile`, layering operator
 * overrides over `.git/config` (the on-disk tier only for a filesystem-backed
 * handle). Returns `undefined` when neither is set, so callers can invoke the
 * verifier with no `opts` exactly as before.
 */
export async function resolveVerifierOpts(repo: GitRepo): Promise<VerifierOptions | undefined> {
	const view = await readConfigView(repo);
	const format = asSignatureFormat(view.get("gpg.format"));
	const allowedSigners = view.get("gpg.ssh.allowedSignersFile");
	if (format === undefined && allowedSigners === undefined) return undefined;
	const opts: VerifierOptions = {};
	if (format !== undefined) opts.format = format;
	if (allowedSigners !== undefined) opts.allowedSigners = allowedSigners;
	return opts;
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
 * Error thrown when verification is requested but cannot be performed —
 * most commonly because no {@link Verifier} is available. Counterpart to
 * {@link SigningError}, giving the read side a typed failure that consumers
 * can catch with `instanceof` instead of string-matching a message.
 */
export class VerificationError extends Error {
	constructor(message = "no signature verifier configured") {
		super(message);
		this.name = "VerificationError";
	}
}

/**
 * Resolve the SDK-level signing decision for a writer (`createCommit`,
 * `buildCommit`, `commit`, `createAnnotatedTag`).
 *
 * Policy (`sign`) and mechanism (the handle's `capabilities.signing.signer`)
 * are independent:
 * - `sign === false` / `undefined` → never sign. An ambient signer alone does
 *   NOT trigger signing from the bare SDK — that is gated by config at the
 *   command layer.
 * - `sign === true` → must sign; resolves the handle's ambient signer and
 *   throws {@link SigningError} if none is present (no silent unsigned commit).
 *
 * The signer is wrap-on-handle only (`withCapabilities(repo, { signing })`);
 * there is no per-call `signer` override.
 */
export function resolveSdkSigning(repo: GitRepo, options: { sign?: boolean }): Signer | undefined {
	if (!options.sign) return undefined;
	const signer = getRepoSigner(repo);
	if (!signer) throw new SigningError();
	return signer;
}

/**
 * Resolve the command-layer signing decision from config + capabilities. The
 * config-driven counterpart to {@link resolveSdkSigning}: layers a CLI flag over
 * `<configKey>` (default `commit.gpgsign`) over `false`, and — when signing —
 * binds the key selection git would use (`opts.keyId` or `user.signingkey`, plus
 * `gpg.format`) onto the returned signer's `opts` so a multi-key / multi-format
 * backend can act on it. This is policy resolution only; the secret never leaves
 * the backend.
 *
 * Returns `undefined` when signing is off; throws {@link SigningError} when
 * signing is required but no signer is configured (mirroring git's
 * `error: gpg failed to sign the data`). The command tier catches that and maps
 * it to a `CommandResult` — keeping the CLI contract out of the data core.
 *
 * Pure (no fs): reads from a materialized {@link ConfigView}.
 */
export function resolveConfiguredSigner(
	repo: GitRepo,
	config: ConfigView,
	cliSign: boolean | undefined,
	configKey = "commit.gpgsign",
	opts?: { keyId?: string },
): Signer | undefined {
	const shouldSign = cliSign ?? configBool(config.get(configKey)) ?? false;
	if (!shouldSign) return undefined;
	const signer = getRepoSigner(repo);
	if (!signer) throw new SigningError();

	const keyId = opts?.keyId ?? config.get("user.signingkey");
	const format = asSignatureFormat(config.get("gpg.format"));
	if (keyId === undefined && format === undefined) return signer;

	// Bind the resolved selection as defaults so every call site forwards it
	// without threading extra arguments through each one.
	return (payload, callOpts) => signer(payload, { keyId, format, ...callOpts });
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
