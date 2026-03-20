import { bytesToHex, hexToBytes } from "../hex.ts";
import type { Tree, TreeEntry } from "../types.ts";

/**
 * Git tree binary format (repeated entries, concatenated):
 *   <mode> <name>\0<20-byte binary SHA-1>
 *
 * Mode is ASCII decimal (e.g. "100644", "40000" — note: no leading zero for directories).
 * Name is the filename (no path separators).
 * Hash is 20 raw bytes (not hex).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const VALID_MODES = new Set(["100644", "100755", "040000", "120000", "160000"]);

/** Case-insensitive check for `.git`. */
function isDotGit(name: string): boolean {
	return name.length === 4 && name.toLowerCase() === ".git";
}

/**
 * Validate a tree entry name and mode.
 * Throws on invalid entries, providing defense-in-depth against
 * malicious trees even when call sites forget `verifyPath`.
 */
function validateTreeEntry(name: string, mode: string): void {
	if (name.length === 0) {
		throw new Error("invalid tree entry: empty name");
	}
	if (name.includes("/")) {
		throw new Error(`invalid tree entry: name contains slash: '${name}'`);
	}
	if (name.includes("\0")) {
		throw new Error(`invalid tree entry: name contains null byte`);
	}
	if (name === "." || name === "..") {
		throw new Error(`invalid tree entry: '${name}'`);
	}
	if (isDotGit(name)) {
		throw new Error(`invalid tree entry: '${name}'`);
	}
	if (!VALID_MODES.has(mode)) {
		throw new Error(`invalid tree entry mode: '${mode}' for '${name}'`);
	}
}

/** Parse raw tree content into a Tree. */
export function parseTree(content: Uint8Array): Tree {
	const entries: TreeEntry[] = [];
	let offset = 0;

	while (offset < content.byteLength) {
		// Find the space separating mode from name
		const spaceIdx = content.indexOf(0x20, offset); // 0x20 = space
		if (spaceIdx === -1) break;

		const mode = decoder.decode(content.subarray(offset, spaceIdx));

		// Find the null byte after the name
		const nullIdx = content.indexOf(0, spaceIdx + 1);
		if (nullIdx === -1) break;

		const name = decoder.decode(content.subarray(spaceIdx + 1, nullIdx));

		// Next 20 bytes are the raw SHA-1
		const hashBytes = content.subarray(nullIdx + 1, nullIdx + 21);
		const hash = bytesToHex(hashBytes);

		// Normalize mode: real git stores "40000" for directories, but our
		// canonical representation uses "040000". Pad to 6 chars.
		const normalizedMode = mode.padStart(6, "0");

		validateTreeEntry(name, normalizedMode);

		entries.push({ mode: normalizedMode, name, hash });
		offset = nullIdx + 21;
	}

	return { type: "tree", entries };
}

/** Serialize a Tree to the raw binary format. */
export function serializeTree(tree: Tree): Uint8Array {
	const parts: Uint8Array[] = [];

	for (const entry of tree.entries) {
		// Real git strips leading zeros from mode in the binary format
		// e.g. "040000" is stored as "40000"
		const mode = entry.mode.replace(/^0+/, "");
		const header = encoder.encode(`${mode} ${entry.name}\0`);
		const hashBytes = hexToBytes(entry.hash);

		parts.push(header);
		parts.push(hashBytes);
	}

	// Concatenate all parts
	const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}
