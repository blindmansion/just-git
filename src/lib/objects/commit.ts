import type { Commit, Identity, ObjectId } from "../types.ts";
import { parseIdentity, serializeIdentity } from "./identity.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Git commit text format:
 *
 *   tree <hash>\n
 *   parent <hash>\n        (zero or more)
 *   author <name> <<email>> <timestamp> <timezone>\n
 *   committer <name> <<email>> <timestamp> <timezone>\n
 *   \n
 *   <message>
 */

/**
 * Parse the header section into ordered `[key, value]` pairs, folding
 * continuation lines (those beginning with a single space) into the
 * preceding header's value. Each continuation line contributes its
 * content with the one leading space removed, joined with `\n`. This is
 * how multi-line headers such as `gpgsig` (an armored signature block)
 * are represented in the on-disk object.
 */
function parseFoldedHeaders(headerSection: string): Array<[string, string]> {
	const headers: Array<[string, string]> = [];
	for (const line of headerSection.split("\n")) {
		// A leading space marks a continuation of the previous header value.
		if (line.startsWith(" ") && headers.length > 0) {
			headers[headers.length - 1]![1] += `\n${line.slice(1)}`;
			continue;
		}
		const spaceIdx = line.indexOf(" ");
		if (spaceIdx === -1) {
			// A valueless key (no known commit header uses this, but keep
			// the line as a header so it isn't mistaken for a continuation).
			headers.push([line, ""]);
			continue;
		}
		headers.push([line.slice(0, spaceIdx), line.slice(spaceIdx + 1)]);
	}
	return headers;
}

/** Parse raw commit content into a Commit. */
export function parseCommit(content: Uint8Array): Commit {
	const text = decoder.decode(content);

	// Split at the first blank line — everything before is headers, after is the message
	const blankLineIdx = text.indexOf("\n\n");
	const headerSection = blankLineIdx === -1 ? text : text.slice(0, blankLineIdx);
	const message = blankLineIdx === -1 ? "" : text.slice(blankLineIdx + 2);

	let tree: ObjectId = "";
	const parents: ObjectId[] = [];
	let author: Identity | undefined;
	let committer: Identity | undefined;
	let gpgsig: string | undefined;
	// Headers we don't model individually (encoding, mergetag, …). Preserved
	// in order so the object re-serializes byte-for-byte (and keeps its hash).
	const extraHeaders: [string, string][] = [];

	for (const [key, value] of parseFoldedHeaders(headerSection)) {
		switch (key) {
			case "tree":
				tree = value;
				break;
			case "parent":
				parents.push(value);
				break;
			case "author":
				author = parseIdentity(value);
				break;
			case "committer":
				committer = parseIdentity(value);
				break;
			case "gpgsig":
				gpgsig = value;
				break;
			default:
				extraHeaders.push([key, value]);
				break;
		}
	}

	if (!tree) throw new Error("Commit missing tree field");
	if (!author) throw new Error("Commit missing author field");
	if (!committer) throw new Error("Commit missing committer field");

	const commit: Commit = { type: "commit", tree, parents, author, committer, message };
	if (gpgsig !== undefined) commit.gpgsig = gpgsig;
	if (extraHeaders.length > 0) commit.extraHeaders = extraHeaders;
	return commit;
}

/**
 * Push a (possibly multi-line) header in git's folded form: `key value` for
 * the first line, then each subsequent line re-indented by a single leading
 * space. The inverse of {@link parseFoldedHeaders}. A blank line inside the
 * value becomes a bare single space, matching how git stores armor blank lines.
 */
function pushFoldedHeader(lines: string[], key: string, value: string): void {
	const valueLines = value.split("\n");
	lines.push(`${key} ${valueLines[0] ?? ""}`);
	for (let i = 1; i < valueLines.length; i++) {
		lines.push(` ${valueLines[i]}`);
	}
}

/** Serialize a Commit to raw bytes. */
export function serializeCommit(commit: Commit): Uint8Array {
	const lines: string[] = [];

	lines.push(`tree ${commit.tree}`);
	for (const parent of commit.parents) {
		lines.push(`parent ${parent}`);
	}
	lines.push(`author ${serializeIdentity(commit.author)}`);
	lines.push(`committer ${serializeIdentity(commit.committer)}`);
	// Unmodeled headers (encoding, mergetag, …) sit after `committer` in their
	// original order, before `gpgsig` (git appends the signature last).
	if (commit.extraHeaders) {
		for (const [key, value] of commit.extraHeaders) {
			pushFoldedHeader(lines, key, value);
		}
	}
	if (commit.gpgsig !== undefined) {
		// The core owns this framing, so it also normalizes the signer's block
		// to git's on-disk form: a trailing newline would split into a stray
		// bare-space continuation line and change the object hash, so strip it
		// here once rather than relying on every backend to do it.
		pushFoldedHeader(lines, "gpgsig", commit.gpgsig.replace(/\n+$/, ""));
	}
	lines.push(""); // blank line before message
	lines.push(commit.message);

	return encoder.encode(lines.join("\n"));
}
