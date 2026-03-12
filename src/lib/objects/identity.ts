import type { Identity } from "../types.ts";

/** Parse an identity line like "Author Name <email@example.com> 1234567890 +0000" */
export function parseIdentity(line: string): Identity {
	const emailStart = line.indexOf("<");
	const emailEnd = line.indexOf(">");
	if (emailStart === -1 || emailEnd === -1) {
		throw new Error(`Malformed identity line: "${line}"`);
	}

	const name = line.slice(0, emailStart).trimEnd();
	const email = line.slice(emailStart + 1, emailEnd);
	const rest = line.slice(emailEnd + 2);
	const [rawTimestamp = "0", timezone = "+0000"] = rest.split(" ");
	const timestamp = parseInt(rawTimestamp, 10);

	return { name, email, timestamp, timezone };
}

/** Serialize an identity to the Git format string. */
export function serializeIdentity(id: Identity): string {
	return `${id.name} <${id.email}> ${id.timestamp} ${id.timezone}`;
}
