import type { Identity, ObjectType, Tag } from "../types.ts";
import { parseIdentity, serializeIdentity } from "./identity.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Git annotated tag text format:
 *
 *   object <hash>\n
 *   type <type>\n
 *   tag <name>\n
 *   tagger <name> <<email>> <timestamp> <timezone>\n
 *   \n
 *   <message>
 */

/** Parse raw tag content into a Tag. */
export function parseTag(content: Uint8Array): Tag {
	const text = decoder.decode(content);

	const blankLineIdx = text.indexOf("\n\n");
	const headerSection = blankLineIdx === -1 ? text : text.slice(0, blankLineIdx);
	const message = blankLineIdx === -1 ? "" : text.slice(blankLineIdx + 2);

	let object = "";
	let objectType: ObjectType = "commit";
	let name = "";
	let tagger: Identity | undefined;

	for (const line of headerSection.split("\n")) {
		const spaceIdx = line.indexOf(" ");
		if (spaceIdx === -1) continue;

		const key = line.slice(0, spaceIdx);
		const value = line.slice(spaceIdx + 1);

		switch (key) {
			case "object":
				object = value;
				break;
			case "type":
				objectType = value as ObjectType;
				break;
			case "tag":
				name = value;
				break;
			case "tagger":
				tagger = parseIdentity(value);
				break;
		}
	}

	if (!object) throw new Error("Tag missing object field");
	if (!name) throw new Error("Tag missing tag name field");
	if (!tagger) throw new Error("Tag missing tagger field");

	return { type: "tag", object, objectType, name, tagger, message };
}

/** Serialize a Tag to raw bytes. */
export function serializeTag(tag: Tag): Uint8Array {
	const lines: string[] = [];

	lines.push(`object ${tag.object}`);
	lines.push(`type ${tag.objectType}`);
	lines.push(`tag ${tag.name}`);
	lines.push(`tagger ${serializeIdentity(tag.tagger)}`);
	lines.push(""); // blank line before message
	lines.push(tag.message);

	return encoder.encode(lines.join("\n"));
}
