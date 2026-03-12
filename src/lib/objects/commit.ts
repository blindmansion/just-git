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

	for (const line of headerSection.split("\n")) {
		const spaceIdx = line.indexOf(" ");
		if (spaceIdx === -1) continue;

		const key = line.slice(0, spaceIdx);
		const value = line.slice(spaceIdx + 1);

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
		}
	}

	if (!tree) throw new Error("Commit missing tree field");
	if (!author) throw new Error("Commit missing author field");
	if (!committer) throw new Error("Commit missing committer field");

	return { type: "commit", tree, parents, author, committer, message };
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
	lines.push(""); // blank line before message
	lines.push(commit.message);

	return encoder.encode(lines.join("\n"));
}
