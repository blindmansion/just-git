/**
 * Validate a logical repository ID.
 *
 * IDs may contain slash-separated components, but not empty, hidden, control,
 * or backslash-containing components.
 */
export function isValidRepoId(id: string): boolean {
	if (id.length === 0) return false;
	for (let i = 0; i < id.length; i++) {
		const c = id.charCodeAt(i);
		if (c === 0 || c < 0x20 || c === 0x7f || c === 0x5c) return false;
	}
	for (const part of id.split("/")) {
		if (part.length === 0 || part.charCodeAt(0) === 0x2e) return false;
	}
	return true;
}
