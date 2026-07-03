/**
 * Generator for git's `GIT binary patch` payload — the literal (deflate) form.
 *
 * `git format-patch` (and `git diff --binary`) emit an appliable binary patch
 * instead of the lossy `Binary files … differ` line: a `GIT binary patch`
 * marker followed by two blocks — the forward payload (reconstructs the new
 * blob) and the reverse payload (reconstructs the old blob) — each a
 * zlib-deflated copy of the blob rendered in git's base85 line encoding.
 *
 * Git picks the smaller of a `delta` or `literal` payload; we always emit
 * `literal` (deflate). That is fully appliable by `git am` / `git apply`
 * (which accept either form) and byte-identical to git whenever git also
 * chose `literal` — the common case for the small / dissimilar blobs where a
 * delta would not win.
 *
 * The framing / base85 mirror `emit_binary_diff_body()` and `encode_85()` in
 * git's `diff.c` / `base85.c`.
 */
import { deflate } from "../pack/zlib.ts";

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
