// ============================================================================
// Core utilities
// ============================================================================

/** Normalize a path, resolving `.` and `..` segments and collapsing slashes */
function normalize(path: string): string {
	if (path === "") return ".";
	if (path === "/") return "/";

	const isAbs = path.charCodeAt(0) === 47;
	const trailingSlash = path.charCodeAt(path.length - 1) === 47;

	const segments = path.split("/");
	const result: string[] = [];

	for (const seg of segments) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (isAbs) {
				result.pop(); // can't go above root
			} else if (result.length > 0 && result[result.length - 1] !== "..") {
				result.pop();
			} else {
				result.push("..");
			}
		} else {
			result.push(seg);
		}
	}

	let out = result.join("/");

	if (isAbs) {
		out = `/${out}`;
	}

	if (trailingSlash && out.length > 1 && !out.endsWith("/")) {
		out += "/";
	}

	return out || (isAbs ? "/" : trailingSlash ? "./" : ".");
}

/** Join path segments and normalize the result */
export function join(...paths: string[]): string {
	if (paths.length === 0) return ".";
	const joined = paths.filter((p) => p !== "").join("/");
	if (joined === "") return ".";
	return normalize(joined);
}

/**
 * Resolve a sequence of paths into a single normalized path.
 *
 * Processes right-to-left. Stops as soon as an absolute path is encountered.
 * Unlike Node's `path.resolve`, this does NOT prepend a working directory
 * when no absolute segment is found — the result stays relative.
 */
export function resolve(...paths: string[]): string {
	let resolved = "";

	for (let i = paths.length - 1; i >= 0; i--) {
		const p = paths[i];
		if (!p) continue;
		resolved = resolved ? `${p}/${resolved}` : p;
		if (p.charCodeAt(0) === 47) break;
	}

	return normalize(resolved || ".");
}

// ============================================================================
// Decomposition
// ============================================================================

/** Return the directory portion of a path */
export function dirname(path: string): string {
	if (path === "") return ".";
	if (path === "/") return "/";

	// Strip trailing slashes
	let end = path.length;
	while (end > 1 && path.charCodeAt(end - 1) === 47) end--;

	const trimmed = path.slice(0, end);
	const i = trimmed.lastIndexOf("/");

	if (i === -1) return ".";
	if (i === 0) return "/";
	return trimmed.slice(0, i);
}

/** Return the last segment of a path, optionally stripping a suffix */
export function basename(path: string, ext?: string): string {
	if (path === "") return "";

	// Strip trailing slashes (unless the entire path is "/")
	let end = path.length;
	while (end > 1 && path.charCodeAt(end - 1) === 47) end--;

	const trimmed = path.slice(0, end);

	// Root "/" → empty basename
	if (trimmed === "/") return "";

	const i = trimmed.lastIndexOf("/");
	const base = i === -1 ? trimmed : trimmed.slice(i + 1);

	if (ext && base.endsWith(ext) && base.length > ext.length) {
		return base.slice(0, base.length - ext.length);
	}

	return base;
}

// ============================================================================
// Relative path computation
// ============================================================================

/** Compute the relative path from `from` to `to` */
export function relative(from: string, to: string): string {
	const fromNorm = normalize(from);
	const toNorm = normalize(to);

	if (fromNorm === toNorm) return "";

	const fromParts = fromNorm === "/" ? [""] : fromNorm.split("/");
	const toParts = toNorm === "/" ? [""] : toNorm.split("/");

	// Skip common root "" for absolute paths
	const fromAbs = fromNorm.charCodeAt(0) === 47;
	const toAbs = toNorm.charCodeAt(0) === 47;

	// Both must be of the same type (both absolute or both relative)
	// to produce a meaningful relative path.
	const startIdx = fromAbs && toAbs ? 1 : 0;

	// Find the common prefix length
	let common = startIdx;
	const minLen = Math.min(fromParts.length, toParts.length);
	while (common < minLen && fromParts[common] === toParts[common]) {
		common++;
	}

	// Number of ".." hops to get from `from` up to the common ancestor
	const ups = fromParts.length - common;
	const rest = toParts.slice(common);

	const parts: string[] = [];
	for (let i = 0; i < ups; i++) parts.push("..");
	for (const r of rest) parts.push(r);

	return parts.join("/") || ".";
}
