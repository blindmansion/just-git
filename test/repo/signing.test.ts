import { beforeAll, describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import * as openpgp from "openpgp";
import { createGit } from "../../src/index.ts";
import { configBool } from "../../src/lib/config.ts";
import { readCommit, readObject, readTag } from "../../src/lib/object-db.ts";
import { parseCommit, serializeCommit } from "../../src/lib/objects/commit.ts";
import { parseTag, serializeTag } from "../../src/lib/objects/tag.ts";
import { findRepo } from "../../src/lib/repo.ts";
import {
	type Signer,
	type Verifier,
	commitSigningPayload,
	tagSigningPayload,
} from "../../src/lib/signing.ts";
import type { Commit, Tag } from "../../src/lib/types.ts";
import { createAnnotatedTag, createCommit } from "../../src/repo/writing.ts";
import { verifyCommit, verifyTag } from "../../src/repo/reading.ts";
import { TEST_ENV } from "../fixtures.ts";

const decoder = new TextDecoder();

// An armored block with an internal blank line (the line that becomes a
// bare " " continuation on disk) to exercise the folded-header framing.
const FAKE_PGP_SIG = [
	"-----BEGIN PGP SIGNATURE-----",
	"",
	"iHUEABYKAB0WIQRexampleexampleexampleexampleexampleAAoJEexampleAA",
	"exampleexampleexampleexampleexampleexampleexampleexampleexample==",
	"=Ab12",
	"-----END PGP SIGNATURE-----",
].join("\n");

const IDENT = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

function envAt(ts: number) {
	return { ...TEST_ENV, GIT_AUTHOR_DATE: String(ts), GIT_COMMITTER_DATE: String(ts) };
}

/** A signer that always returns the fixed fake block (records its payloads). */
function stubSigner(): { signer: Signer; payloads: Uint8Array[] } {
	const payloads: Uint8Array[] = [];
	const signer: Signer = (payload) => {
		payloads.push(payload);
		return FAKE_PGP_SIG;
	};
	return { signer, payloads };
}

/** A verifier that says "good" iff the signature equals the fake block. */
const stubVerifier: Verifier = (_payload, signature) =>
	signature === FAKE_PGP_SIG
		? { status: "good", format: "openpgp", signer: { name: "Test" } }
		: { status: "bad", format: "openpgp" };

async function initRepoWithCommit(signing?: {
	signer?: Signer;
	verifier?: Verifier;
}): Promise<{ git: ReturnType<typeof createGit>; fs: InMemoryFs }> {
	const fs = new InMemoryFs();
	const git = createGit(signing ? { signing } : undefined);
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
	await bash.writeFile("/repo/README.md", "# Hello\n");
	await bash.exec("git init", { env: TEST_ENV });
	await bash.exec("git add .", { env: TEST_ENV });
	await bash.exec('git commit -m "initial"', { env: envAt(1000000000) });
	return { git, fs };
}

// ── Layer 1: object round-trip ──────────────────────────────────────

describe("commit gpgsig round-trip", () => {
	test("parse + serialize preserves the signature byte-for-byte", () => {
		const commit: Commit = {
			type: "commit",
			tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			parents: [],
			author: IDENT,
			committer: IDENT,
			message: "subject\n",
			gpgsig: FAKE_PGP_SIG,
		};
		const bytes = serializeCommit(commit);
		const raw = decoder.decode(bytes);
		// Header is placed after committer with one-space continuation lines.
		expect(raw).toContain("committer Test <test@test.com> 1000000000 +0000\n");
		expect(raw).toContain("gpgsig -----BEGIN PGP SIGNATURE-----\n");
		expect(raw).toContain(" -----END PGP SIGNATURE-----\n");
		// The internal blank armor line is stored as a bare continuation space.
		expect(raw).toContain("gpgsig -----BEGIN PGP SIGNATURE-----\n \n");

		const parsed = parseCommit(bytes);
		expect(parsed.gpgsig).toBe(FAKE_PGP_SIG);
		expect(parsed.message).toBe("subject\n");
		expect(parsed.tree).toBe(commit.tree);
		// Re-serialization is byte-identical.
		expect(serializeCommit(parsed)).toEqual(bytes);
	});

	test("unsigned commits have no gpgsig and no header", () => {
		const commit: Commit = {
			type: "commit",
			tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			parents: [],
			author: IDENT,
			committer: IDENT,
			message: "m\n",
		};
		const raw = decoder.decode(serializeCommit(commit));
		expect(raw).not.toContain("gpgsig");
		expect(parseCommit(serializeCommit(commit)).gpgsig).toBeUndefined();
	});

	test("commitSigningPayload strips the gpgsig header", () => {
		const signed: Commit = {
			type: "commit",
			tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			parents: [],
			author: IDENT,
			committer: IDENT,
			message: "m\n",
			gpgsig: FAKE_PGP_SIG,
		};
		const payload = decoder.decode(commitSigningPayload(signed));
		expect(payload).not.toContain("gpgsig");
		expect(payload).toBe(decoder.decode(serializeCommit({ ...signed, gpgsig: undefined })));
	});
});

describe("tag gpgsig round-trip", () => {
	test("signature is appended after the message and round-trips", () => {
		const tag: Tag = {
			type: "tag",
			object: "1234567890123456789012345678901234567890",
			objectType: "commit",
			name: "v1.0.0",
			tagger: IDENT,
			message: "Release 1.0.0\n",
			gpgsig: FAKE_PGP_SIG,
		};
		const bytes = serializeTag(tag);
		const raw = decoder.decode(bytes);
		// Tag signatures are NOT a header — they follow the message body.
		expect(raw).toContain("Release 1.0.0\n-----BEGIN PGP SIGNATURE-----");
		expect(raw).not.toContain("gpgsig");

		const parsed = parseTag(bytes);
		expect(parsed.message).toBe("Release 1.0.0\n");
		expect(parsed.gpgsig).toBe(FAKE_PGP_SIG);
		expect(serializeTag(parsed)).toEqual(bytes);
	});

	test("tagSigningPayload strips the trailing signature", () => {
		const tag: Tag = {
			type: "tag",
			object: "1234567890123456789012345678901234567890",
			objectType: "commit",
			name: "v1",
			tagger: IDENT,
			message: "msg\n",
			gpgsig: FAKE_PGP_SIG,
		};
		const payload = decoder.decode(tagSigningPayload(tag));
		expect(payload).not.toContain("SIGNATURE");
		expect(payload.endsWith("msg\n")).toBe(true);
	});
});

// ── config helper ───────────────────────────────────────────────────

describe("configBool", () => {
	test("git truthiness", () => {
		for (const v of ["true", "yes", "on", "1", "", "TRUE", " On "]) {
			expect(configBool(v)).toBe(true);
		}
		for (const v of ["false", "no", "off", "0", "FALSE"]) {
			expect(configBool(v)).toBe(false);
		}
		expect(configBool(undefined)).toBeUndefined();
		expect(configBool("maybe")).toBeUndefined();
	});
});

// ── Layer 2: SDK writers ────────────────────────────────────────────

describe("SDK signing", () => {
	test("createCommit signs with an ambient signer when sign:true", async () => {
		const { signer, payloads } = stubSigner();
		const { git, fs } = await initRepoWithCommit({ signer });
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		const head = (await repo.refStore.readRef("refs/heads/main")) ?? null;
		const parent = head && head.type === "direct" ? head.hash : null;
		const parentCommit = await readCommit(repo, parent!);

		const hash = await createCommit(repo, {
			tree: parentCommit.tree,
			parents: [parent!],
			author: IDENT,
			message: "signed\n",
			sign: true,
		});
		const commit = await readCommit(repo, hash);
		expect(commit.gpgsig).toBe(FAKE_PGP_SIG);
		expect(payloads.length).toBe(1);
		// The signed payload is the commit without the signature.
		expect(decoder.decode(payloads[0]!)).not.toContain("gpgsig");
	});

	test("a per-call signer implies signing without sign:true", async () => {
		const { signer } = stubSigner();
		const { git, fs } = await initRepoWithCommit();
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		const head = ((await repo.refStore.readRef("refs/heads/main")) as { hash: string }).hash;
		const parentCommit = await readCommit(repo, head);
		const hash = await createCommit(repo, {
			tree: parentCommit.tree,
			parents: [],
			author: IDENT,
			message: "m\n",
			signer,
		});
		expect((await readCommit(repo, hash)).gpgsig).toBe(FAKE_PGP_SIG);
	});

	test("sign:false suppresses an ambient signer", async () => {
		const { signer } = stubSigner();
		const { git, fs } = await initRepoWithCommit({ signer });
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		const hash = await createCommit(repo, {
			tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			parents: [],
			author: IDENT,
			message: "m\n",
			sign: false,
		});
		expect((await readCommit(repo, hash)).gpgsig).toBeUndefined();
	});

	test("sign:true with no signer throws", async () => {
		const { git, fs } = await initRepoWithCommit();
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		await expect(
			createCommit(repo, {
				tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
				parents: [],
				author: IDENT,
				message: "m\n",
				sign: true,
			}),
		).rejects.toThrow(/gpg failed to sign/);
	});

	test("createAnnotatedTag signs (signature appended after body)", async () => {
		const { signer } = stubSigner();
		const { git, fs } = await initRepoWithCommit({ signer });
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		const target = ((await repo.refStore.readRef("refs/heads/main")) as { hash: string }).hash;
		const tagHash = await createAnnotatedTag(repo, {
			target,
			name: "v1.0.0",
			tagger: IDENT,
			message: "release\n",
			sign: true,
		});
		const tag = await readTag(repo, tagHash);
		expect(tag.gpgsig).toBe(FAKE_PGP_SIG);
	});
});

// ── Layer 2: command paths ──────────────────────────────────────────

describe("git commit signing", () => {
	test("-S signs the commit", async () => {
		const { signer } = stubSigner();
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		const res = await bash.exec('git commit -S -m "x"', { env: envAt(1000000000) });
		expect(res.exitCode).toBe(0);
		const repo = (await findRepo(fs, "/repo"))!;
		const head = ((await repo.refStore.readRef("refs/heads/main")) as { hash: string }).hash;
		const rawCommit = decoder.decode((await readObject(repo, head)).content);
		expect(rawCommit).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
		expect((await readCommit(repo, head)).gpgsig).toBe(FAKE_PGP_SIG);
	});

	test("commit.gpgsign=true config signs by default", async () => {
		const { signer } = stubSigner();
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git config set commit.gpgsign true", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "x"', { env: envAt(1000000000) });
		const repo = (await findRepo(fs, "/repo"))!;
		const head = ((await repo.refStore.readRef("refs/heads/main")) as { hash: string }).hash;
		expect((await readCommit(repo, head)).gpgsig).toBe(FAKE_PGP_SIG);
	});

	test("--no-gpg-sign overrides commit.gpgsign=true", async () => {
		const { signer } = stubSigner();
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git config set commit.gpgsign true", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit --no-gpg-sign -m "x"', { env: envAt(1000000000) });
		const repo = (await findRepo(fs, "/repo"))!;
		const head = ((await repo.refStore.readRef("refs/heads/main")) as { hash: string }).hash;
		expect((await readCommit(repo, head)).gpgsig).toBeUndefined();
	});

	test("locked commit.gpgsign=true with no signer fails the commit", async () => {
		const fs = new InMemoryFs();
		const git = createGit({ config: { locked: { "commit.gpgsign": "true" } } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		const res = await bash.exec('git commit -m "x"', { env: envAt(1000000000) });
		expect(res.exitCode).toBe(128);
		expect(res.stderr).toContain("gpg failed to sign the data");
	});
});

describe("git tag signing", () => {
	test("-s signs the annotated tag", async () => {
		const { signer } = stubSigner();
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "x"', { env: envAt(1000000000) });
		const res = await bash.exec('git tag -s -m "rel" v1', { env: envAt(1000000000) });
		expect(res.exitCode).toBe(0);
		const repo = (await findRepo(fs, "/repo"))!;
		const tagHash = ((await repo.refStore.readRef("refs/tags/v1")) as { hash: string }).hash;
		expect((await readTag(repo, tagHash)).gpgsig).toBe(FAKE_PGP_SIG);
	});

	// Real git (validated against 2.53.0): tag.forceSignAnnotated signs an
	// *implicitly* annotated tag (-m / -F without -a), but an explicit
	// --annotate on the command line takes precedence and is NOT signed.
	async function setupForceSign(): Promise<{ bash: Bash; fs: InMemoryFs }> {
		const { signer } = stubSigner();
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "x"', { env: envAt(1000000000) });
		await bash.exec("git config set tag.forcesignannotated true", { env: TEST_ENV });
		return { bash, fs };
	}

	test("tag.forceSignAnnotated signs an implicitly annotated tag (-m, no -a)", async () => {
		const { bash, fs } = await setupForceSign();
		await bash.exec('git tag -m "implicit" v-implicit', { env: envAt(1000000000) });
		const repo = (await findRepo(fs, "/repo"))!;
		const tagHash = ((await repo.refStore.readRef("refs/tags/v-implicit")) as { hash: string })
			.hash;
		expect((await readTag(repo, tagHash)).gpgsig).toBe(FAKE_PGP_SIG);
	});

	test("explicit --annotate takes precedence over tag.forceSignAnnotated (unsigned)", async () => {
		const { bash, fs } = await setupForceSign();
		await bash.exec('git tag -a -m "explicit" v-explicit', { env: envAt(1000000000) });
		const repo = (await findRepo(fs, "/repo"))!;
		const tagHash = ((await repo.refStore.readRef("refs/tags/v-explicit")) as { hash: string })
			.hash;
		expect((await readTag(repo, tagHash)).gpgsig).toBeUndefined();
	});

	test("tag.gpgSign signs even an explicit --annotate tag", async () => {
		const { signer } = stubSigner();
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "x"', { env: envAt(1000000000) });
		await bash.exec("git config set tag.gpgsign true", { env: TEST_ENV });
		await bash.exec('git tag -a -m "explicit" v-gpgsign', { env: envAt(1000000000) });
		const repo = (await findRepo(fs, "/repo"))!;
		const tagHash = ((await repo.refStore.readRef("refs/tags/v-gpgsign")) as { hash: string }).hash;
		expect((await readTag(repo, tagHash)).gpgsig).toBe(FAKE_PGP_SIG);
	});
});

// ── Layer 3: verification ───────────────────────────────────────────

describe("verifyCommit / verifyTag", () => {
	test("verifyCommit returns the verdict for a signed commit", async () => {
		const { signer } = stubSigner();
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer, verifier: stubVerifier } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -S -m "x"', { env: envAt(1000000000) });
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		const result = await verifyCommit(repo, "HEAD");
		expect(result?.status).toBe("good");
	});

	test("verifyCommit returns null for an unsigned commit", async () => {
		const fs = new InMemoryFs();
		const git = createGit({ signing: { verifier: stubVerifier } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "x"', { env: envAt(1000000000) });
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		expect(await verifyCommit(repo, "HEAD")).toBeNull();
	});

	test("verifyTag verifies a signed annotated tag", async () => {
		const { signer } = stubSigner();
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer, verifier: stubVerifier } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "x"', { env: envAt(1000000000) });
		await bash.exec('git tag -s -m "rel" v1', { env: envAt(1000000000) });
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		const result = await verifyTag(repo, "v1");
		expect(result?.status).toBe("good");
	});
});

// ── Command verification (merge --verify-signatures) ────────────────

describe("merge --verify-signatures", () => {
	async function setup(signFeature: boolean) {
		const { signer } = stubSigner();
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer, verifier: stubVerifier } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "base"', { env: envAt(1000000000) });
		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/b.txt", "b\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec(`git commit ${signFeature ? "-S " : ""}-m "feat"`, { env: envAt(1000000002) });
		await bash.exec("git checkout main", { env: TEST_ENV });
		return bash;
	}

	test("passes when the side branch tip is signed", async () => {
		const bash = await setup(true);
		const res = await bash.exec("git merge --verify-signatures --no-ff -m m feature", {
			env: envAt(1000000004),
		});
		expect(res.exitCode).toBe(0);
	});

	test("aborts when the side branch tip is unsigned", async () => {
		const bash = await setup(false);
		const revParse = await bash.exec("git rev-parse feature", { env: TEST_ENV });
		const fullHash = revParse.stdout.trim();
		const res = await bash.exec("git merge --verify-signatures --no-ff -m m feature", {
			env: envAt(1000000004),
		});
		expect(res.exitCode).not.toBe(0);
		expect(res.stderr).toContain("does not have a GPG signature");
		// git identifies the commit by its abbreviated (7-char) hash, not the full one.
		expect(res.stderr).toContain(`Commit ${fullHash.slice(0, 7)} does not have a GPG signature`);
		expect(res.stderr).not.toContain(fullHash);
	});
});

// ── Layer 4: real crypto via openpgp.js ─────────────────────────────
//
// The tests above use stub signer/verifier callbacks to exercise the
// plumbing. These exercise the SAME `Signer`/`Verifier` seam with a real
// OpenPGP implementation, proving the byte-for-byte signing payload
// contract (`commitSigningPayload` / `tagSigningPayload`) and the
// gpgsig object framing actually hold up against genuine signatures.

/**
 * Real `Signer`: produce an armored detached OpenPGP signature over the
 * canonical payload, trimming the trailing newline to match git's gpgsig
 * framing (git stores no trailing newline inside the header value).
 */
function makeOpenpgpSigner(armoredPrivateKey: string): Signer {
	return async (payload) => {
		const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
		const message = await openpgp.createMessage({ binary: payload });
		const armored = (await openpgp.sign({
			message,
			signingKeys: privateKey,
			detached: true,
			format: "armored",
		})) as string;
		return armored.replace(/\n+$/, "");
	};
}

/** Real `Verifier`: check an armored detached signature against the payload. */
function makeOpenpgpVerifier(armoredPublicKey: string): Verifier {
	return async (payload, signature) => {
		const publicKey = await openpgp.readKey({ armoredKey: armoredPublicKey });
		const message = await openpgp.createMessage({ binary: payload });
		const sig = await openpgp.readSignature({ armoredSignature: signature });
		const { signatures } = await openpgp.verify({
			message,
			signature: sig,
			verificationKeys: publicKey,
			format: "binary",
		});
		const first = signatures[0];
		if (!first) return { status: "cannot-check", format: "openpgp" };
		try {
			await first.verified;
			return { status: "good", format: "openpgp", keyId: first.keyID.toHex() };
		} catch {
			return { status: "bad", format: "openpgp" };
		}
	};
}

describe("openpgp.js end-to-end (real signing & verification)", () => {
	let signer: Signer;
	let verifier: Verifier;

	beforeAll(async () => {
		const { privateKey, publicKey } = await openpgp.generateKey({
			type: "curve25519",
			userIDs: [{ name: "OpenPGP Tester", email: "openpgp@example.com" }],
			format: "armored",
		});
		signer = makeOpenpgpSigner(privateKey);
		verifier = makeOpenpgpVerifier(publicKey);
	});

	async function initSignedRepo(): Promise<{
		git: ReturnType<typeof createGit>;
		fs: InMemoryFs;
		bash: Bash;
	}> {
		const fs = new InMemoryFs();
		const git = createGit({ signing: { signer, verifier } });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/a.txt", "a\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		return { git, fs, bash };
	}

	test("git commit -S produces a real signature openpgp verifies", async () => {
		const { git, fs, bash } = await initSignedRepo();
		const res = await bash.exec('git commit -S -m "real signed"', { env: envAt(1000000000) });
		expect(res.exitCode).toBe(0);

		const repo = (await findRepo(fs, "/repo"))!;
		const head = ((await repo.refStore.readRef("refs/heads/main")) as { hash: string }).hash;
		const raw = decoder.decode((await readObject(repo, head)).content);
		expect(raw).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");

		// Verify both via the SDK helper and directly against the canonical payload.
		const result = await verifyCommit((await git.findRepo({ fs, cwd: "/repo" }))!, "HEAD");
		expect(result?.status).toBe("good");

		const commit = await readCommit(repo, head);
		const direct = await verifier(commitSigningPayload(commit), commit.gpgsig!);
		expect(direct.status).toBe("good");
	});

	test("a tampered commit body fails verification (payload contract holds)", async () => {
		// Sign a real commit object, then verify the original signature against a
		// mutated payload — this exercises commitSigningPayload + real crypto.
		const original: Commit = {
			type: "commit",
			tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			parents: [],
			author: IDENT,
			committer: IDENT,
			message: "honest message\n",
		};
		original.gpgsig = await signer(commitSigningPayload(original));
		expect((await verifier(commitSigningPayload(original), original.gpgsig)).status).toBe("good");

		const tampered: Commit = { ...original, message: "rewritten message\n" };
		expect((await verifier(commitSigningPayload(tampered), original.gpgsig!)).status).toBe("bad");
	});

	test("gpgsig survives serialize/parse and still verifies", async () => {
		const commit: Commit = {
			type: "commit",
			tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			parents: ["1111111111111111111111111111111111111111"],
			author: IDENT,
			committer: IDENT,
			message: "round trip\n",
		};
		commit.gpgsig = await signer(commitSigningPayload(commit));

		// Round-trip through just-git's object framing (the riskiest part: the
		// folded multi-line gpgsig header must survive byte-for-byte).
		const parsed = parseCommit(serializeCommit(commit));
		expect(parsed.gpgsig).toBe(commit.gpgsig);
		const result = await verifier(commitSigningPayload(parsed), parsed.gpgsig!);
		expect(result.status).toBe("good");
	});

	test("git tag -s produces a real signature openpgp verifies", async () => {
		const { git, fs, bash } = await initSignedRepo();
		await bash.exec('git commit -m "base"', { env: envAt(1000000000) });
		const res = await bash.exec('git tag -s -m "release" v1.0.0', { env: envAt(1000000000) });
		expect(res.exitCode).toBe(0);
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		const result = await verifyTag(repo, "v1.0.0");
		expect(result?.status).toBe("good");
	});

	test("SDK createCommit + createAnnotatedTag (sign:true) verify with openpgp", async () => {
		const { git, fs } = await initSignedRepo();
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;

		const commitHash = await createCommit(repo, {
			tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			parents: [],
			author: IDENT,
			message: "sdk signed\n",
			branch: "refs/heads/main",
			sign: true,
		});
		expect((await verifyCommit(repo, commitHash))?.status).toBe("good");

		const tagHash = await createAnnotatedTag(repo, {
			target: commitHash,
			name: "sdk-tag",
			tagger: IDENT,
			message: "sdk tag\n",
			sign: true,
		});
		expect((await readTag(repo, tagHash)).gpgsig).toContain("-----BEGIN PGP SIGNATURE-----");
		expect((await verifyTag(repo, "sdk-tag"))?.status).toBe("good");
	});

	test("merge --verify-signatures accepts a real openpgp-signed tip", async () => {
		const { bash } = await initSignedRepo();
		await bash.exec('git commit -m "base"', { env: envAt(1000000000) });
		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/b.txt", "b\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -S -m "feat"', { env: envAt(1000000002) });
		await bash.exec("git checkout main", { env: TEST_ENV });
		const res = await bash.exec("git merge --verify-signatures --no-ff -m m feature", {
			env: envAt(1000000004),
		});
		expect(res.exitCode).toBe(0);
	});
});
