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

/**
 * Armored signature openings recognized at the start of a line in a
 * signed annotated tag body. Unlike commits (which use a `gpgsig`
 * header), git appends the signature after the tag message.
 */
const TAG_SIGNATURE_MARKERS = [
	"-----BEGIN PGP SIGNATURE-----",
	"-----BEGIN SSH SIGNATURE-----",
	"-----BEGIN SIGNED MESSAGE-----",
];

/**
 * Split a tag body into the message and an optional trailing armored
 * signature. The signature begins at the first line that exactly starts
 * one of the known armor blocks; everything from there to the end is the
 * signature, and everything before it is the message.
 */
function splitTagSignature(body: string): { message: string; gpgsig?: string } {
	let best = -1;
	for (const marker of TAG_SIGNATURE_MARKERS) {
		let idx = body.indexOf(marker);
		while (idx !== -1) {
			if ((idx === 0 || body[idx - 1] === "\n") && (best === -1 || idx < best)) {
				best = idx;
				break;
			}
			idx = body.indexOf(marker, idx + 1);
		}
	}
	if (best === -1) return { message: body };
	return { message: body.slice(0, best), gpgsig: body.slice(best) };
}

/** Parse raw tag content into a Tag. */
export function parseTag(content: Uint8Array): Tag {
	const text = decoder.decode(content);

	const blankLineIdx = text.indexOf("\n\n");
	const headerSection = blankLineIdx === -1 ? text : text.slice(0, blankLineIdx);
	const body = blankLineIdx === -1 ? "" : text.slice(blankLineIdx + 2);

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

	const { message, gpgsig } = splitTagSignature(body);
	const tag: Tag = { type: "tag", object, objectType, name, tagger, message };
	if (gpgsig !== undefined) tag.gpgsig = gpgsig;
	return tag;
}

/** Serialize a Tag to raw bytes. */
export function serializeTag(tag: Tag): Uint8Array {
	const lines: string[] = [];

	lines.push(`object ${tag.object}`);
	lines.push(`type ${tag.objectType}`);
	lines.push(`tag ${tag.name}`);
	lines.push(`tagger ${serializeIdentity(tag.tagger)}`);
	lines.push(""); // blank line before message
	// A tag signature is appended verbatim after the message body. The
	// message conventionally ends with a newline, so the armor follows on
	// its own line — matching git's on-disk layout.
	lines.push(tag.gpgsig !== undefined ? tag.message + tag.gpgsig : tag.message);

	return encoder.encode(lines.join("\n"));
}
