/**
 * Encoder + decoder for git's `GIT binary patch` payload.
 *
 * **Encode** (`formatBinaryPatch`): `git format-patch` / `git diff --binary`
 * emit an appliable binary patch instead of the lossy `Binary files … differ`
 * line: a `GIT binary patch` marker followed by two blocks — the forward
 * payload (reconstructs the new blob) and the reverse payload (reconstructs
 * the old blob) — each a zlib-deflated copy of the blob rendered in git's
 * base85 line encoding. Git picks the smaller of a `delta` or `literal`
 * payload; we always emit `literal` (deflate), which is fully appliable by
 * `git am` / `git apply` (they accept either form) and byte-identical to git
 * whenever git also chose `literal` — the common case for the small /
 * dissimilar blobs where a delta would not win.
 *
 * **Decode** (`parseBinaryPatch` + `decode85`): `git apply` must accept both
 * `literal` and `delta` forms (git emits whichever is smaller). Parsing is the
 * inverse of the emit path; the framing / base85 mirror `parse_binary_hunk()`
 * and `decode_85()` in git's `apply.c` / `base85.c`. Because our zlib wrapper
 * is async but the patch parser is synchronous, `parseBinaryPatch` decodes the
 * base85 framing eagerly but keeps the payload zlib-deflated; call
 * `inflateBinaryHunk` at apply time to obtain the raw bytes.
 *
 * The framing / base85 mirror `emit_binary_diff_body()` and `encode_85()` in
 * git's `diff.c` / `base85.c`.
 */
import { splitLinesWithNL } from "./algorithm.ts";
import { deflate, inflate } from "../pack/zlib.ts";

/**
 * git deflates binary-diff payloads at `zlib_compression_level`, which git
 * initializes to `Z_BEST_SPEED` (1) — not zlib's default (6). Matching it keeps
 * the emitted stream byte-identical to git's.
 */
const GIT_BINARY_DIFF_COMPRESSION = 1;

/** git's base85 alphabet (`en85[]` in base85.c). */
const EN85 =
	"0123456789" +
	"ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
	"abcdefghijklmnopqrstuvwxyz" +
	"!#$%&()*+-;<=>?@^_`{|}~";

/**
 * base85-encode a byte run git-style: 4 input bytes → 5 output chars, the last
 * group zero-padded. Each 4-byte group is packed big-endian into a 32-bit
 * accumulator, then emitted as five base-85 digits, most significant first.
 */
function encode85(data: Uint8Array): string {
	let out = "";
	let i = 0;
	const n = data.length;
	while (i < n) {
		// Pack up to 4 bytes big-endian (missing low bytes stay 0). `2 ** cnt`
		// keeps the accumulator a non-negative double (a `<< 24` would go
		// negative in int32 space and break the `% 85` digit extraction).
		let acc = 0;
		for (let cnt = 24; cnt >= 0; cnt -= 8) {
			acc += (data[i++] as number) * 2 ** cnt;
			if (i >= n) break;
		}
		const chars = ["", "", "", "", ""];
		for (let cnt = 4; cnt >= 0; cnt--) {
			chars[cnt] = EN85[acc % 85] as string;
			acc = Math.floor(acc / 85);
		}
		out += chars.join("");
	}
	return out;
}

/**
 * Render one `literal <origSize>` block: the deflated payload split into lines
 * of at most 52 source bytes, each prefixed by a length char (`A`–`Z` for
 * 1–26 bytes, `a`–`z` for 27–52). Ends with a trailing newline.
 */
function emitLiteralBlock(deflated: Uint8Array, origSize: number): string {
	let out = `literal ${origSize}\n`;
	for (let cp = 0; cp < deflated.length; ) {
		const bytes = Math.min(deflated.length - cp, 52);
		const lenChar =
			bytes <= 26
				? String.fromCharCode(bytes + "A".charCodeAt(0) - 1)
				: String.fromCharCode(bytes - 26 + "a".charCodeAt(0) - 1);
		out += `${lenChar}${encode85(deflated.subarray(cp, cp + bytes))}\n`;
		cp += bytes;
	}
	return out;
}

/**
 * Build the full `GIT binary patch` section (excluding the leading `diff --git`
 * / `index` header) for a blob that changed from `oldBytes` to `newBytes`:
 *
 * ```
 * GIT binary patch
 * literal <newBytes.length>
 * <base85 forward payload>
 *
 * literal <oldBytes.length>
 * <base85 reverse payload>
 *
 * ```
 *
 * The returned string ends with the trailing blank line git writes after the
 * reverse block, so callers append it directly after the `index` line.
 */
export async function formatBinaryPatch(
	oldBytes: Uint8Array,
	newBytes: Uint8Array,
): Promise<string> {
	const forward = emitLiteralBlock(
		await deflate(newBytes, GIT_BINARY_DIFF_COMPRESSION),
		newBytes.length,
	);
	const reverse = emitLiteralBlock(
		await deflate(oldBytes, GIT_BINARY_DIFF_COMPRESSION),
		oldBytes.length,
	);
	return `GIT binary patch\n${forward}\n${reverse}\n`;
}

// ── Decode ──────────────────────────────────────────────────────────

/**
 * Inverse of {@link EN85}: base85 char code → value + 1 (0 means "not in the
 * alphabet", matching git's `de85[]` where a stored `i + 1` lets `--de < 0`
 * flag an invalid character). Built once from `EN85`.
 */
const DE85: Int8Array = (() => {
	const table = new Int8Array(256);
	for (let i = 0; i < EN85.length; i++) {
		table[EN85.charCodeAt(i)] = i + 1;
	}
	return table;
})();

/**
 * Decode `len` bytes from git-style base85 (`base85.c` `decode_85`). `chars`
 * holds the base85 digits (no length byte, no newline); every 5 digits decode
 * to up to 4 bytes, the final group possibly short. Throws on an invalid digit
 * or a group that overflows the 32-bit accumulator (git's overflow guard).
 */
function decode85(chars: string, len: number): Uint8Array {
	const out = new Uint8Array(len);
	let di = 0;
	let bi = 0;
	let remaining = len;
	while (remaining > 0) {
		let acc = 0;
		for (let cnt = 0; cnt < 4; cnt++) {
			const de = (DE85[chars.charCodeAt(bi++)] ?? 0) - 1;
			if (de < 0) throw new Error("invalid base85 alphabet");
			acc = acc * 85 + de;
		}
		const de = (DE85[chars.charCodeAt(bi++)] ?? 0) - 1;
		if (de < 0) throw new Error("invalid base85 alphabet");
		// Overflow detection, mirroring git: acc*85 + de must fit in uint32.
		if (Math.floor(0xffffffff / 85) < acc) throw new Error("invalid base85 sequence");
		acc *= 85;
		if (0xffffffff - de < acc) throw new Error("invalid base85 sequence");
		acc += de;

		let cnt = remaining < 4 ? remaining : 4;
		remaining -= cnt;
		// Emit big-endian: git left-rotates the accumulator by 8 and takes the
		// low byte each step, which peels off the most-significant byte first.
		while (cnt-- > 0) {
			acc = ((acc << 8) | (acc >>> 24)) >>> 0;
			out[di++] = acc & 0xff;
		}
	}
	return out;
}

/** A decoded binary hunk (git's `struct fragment` with `binary_patch_method`). */
export interface BinaryHunk {
	/** `literal` reconstructs the whole blob; `delta` is a delta vs the base. */
	method: "literal" | "delta";
	/** zlib-deflated payload (base85 already decoded). Inflate before use. */
	deflated: Uint8Array;
	/** Inflated (pre-deflate) size from the header line — validates the inflate. */
	inflatedSize: number;
}

/**
 * A parsed `GIT binary patch`: a mandatory forward hunk (applied to the
 * preimage → postimage) and an optional reverse hunk (postimage → preimage,
 * used under `-R`).
 */
export interface BinaryPatch {
	forward: BinaryHunk;
	reverse: BinaryHunk | null;
}

/** Thrown when a `GIT binary patch` block is malformed. */
export class BinaryPatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BinaryPatchError";
	}
}

/**
 * Parse one binary hunk (`parse_binary_hunk`) beginning at `lines[start]`.
 * Returns the decoded hunk and the index just past its terminating blank line,
 * or `null` when the line is not a `literal`/`delta` method header (git treats
 * a missing reverse hunk as non-fatal). Throws {@link BinaryPatchError} on a
 * corrupt hunk.
 */
function parseBinaryHunk(
	lines: string[],
	start: number,
): { hunk: BinaryHunk; next: number } | null {
	if (start >= lines.length) return null;
	const header = lines[start] as string;
	let method: "literal" | "delta";
	let inflatedSize: number;
	if (header.startsWith("delta ")) {
		method = "delta";
		inflatedSize = Number.parseInt(header.slice(6), 10);
	} else if (header.startsWith("literal ")) {
		method = "literal";
		inflatedSize = Number.parseInt(header.slice(8), 10);
	} else {
		return null;
	}
	if (Number.isNaN(inflatedSize)) throw new BinaryPatchError("corrupt binary patch");

	const chunks: Uint8Array[] = [];
	let total = 0;
	let i = start + 1;
	for (; i < lines.length; i++) {
		const line = lines[i] as string;
		const body = line.endsWith("\n") ? line.slice(0, -1) : line;
		// A blank line terminates the hunk (and is consumed).
		if (body.length === 0) {
			i++;
			break;
		}
		// Min line is "A00000\n" (7 bytes incl. newline); the base85 run
		// (everything after the length byte) must be a non-empty multiple of 5.
		const base85 = body.slice(1);
		if (body.length < 6 || base85.length % 5 !== 0) {
			throw new BinaryPatchError("corrupt binary patch");
		}
		const maxByteLength = (base85.length / 5) * 4;
		const lenChar = body.charCodeAt(0);
		let byteLength: number;
		if (lenChar >= 0x41 && lenChar <= 0x5a) {
			byteLength = lenChar - 0x41 + 1; // 'A'..'Z' → 1..26
		} else if (lenChar >= 0x61 && lenChar <= 0x7a) {
			byteLength = lenChar - 0x61 + 27; // 'a'..'z' → 27..52
		} else {
			throw new BinaryPatchError("corrupt binary patch");
		}
		// Filler (input not a multiple of 4) is at most 3 bytes.
		if (maxByteLength < byteLength || byteLength <= maxByteLength - 4) {
			throw new BinaryPatchError("corrupt binary patch");
		}
		let decoded: Uint8Array;
		try {
			decoded = decode85(base85, byteLength);
		} catch {
			throw new BinaryPatchError("corrupt binary patch");
		}
		chunks.push(decoded);
		total += decoded.length;
	}

	const deflated = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		deflated.set(c, off);
		off += c.length;
	}
	return { hunk: { method, deflated, inflatedSize }, next: i };
}

/**
 * Parse a `GIT binary patch` body (the text after the `GIT binary patch`
 * marker line) into its forward and optional reverse hunks. Mirrors git's
 * `parse_binary`. Throws {@link BinaryPatchError} when the mandatory forward
 * hunk is missing or either hunk is corrupt.
 */
export function parseBinaryPatch(text: string): BinaryPatch {
	const lines = splitLinesWithNL(text);
	const forward = parseBinaryHunk(lines, 0);
	if (!forward) throw new BinaryPatchError("unrecognized binary patch");
	const reverse = parseBinaryHunk(lines, forward.next);
	return { forward: forward.hunk, reverse: reverse ? reverse.hunk : null };
}

/**
 * Inflate a decoded {@link BinaryHunk}'s deflated payload, validating the
 * result against the header's declared size (git's `inflate_it`).
 */
export async function inflateBinaryHunk(hunk: BinaryHunk): Promise<Uint8Array> {
	const out = await inflate(hunk.deflated);
	if (out.length !== hunk.inflatedSize) {
		throw new BinaryPatchError(
			`binary patch inflate size mismatch: got ${out.length}, expected ${hunk.inflatedSize}`,
		);
	}
	return out;
}
