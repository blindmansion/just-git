import { join } from "./path.ts";
import type { GitContext } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

export type GitConfigSection = Record<string, string>;
export type GitConfig = Record<string, GitConfigSection>;

// ── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a section header: `[section]`, `[section "subsection"]`, or
 * `[section.subsection]`.  Returns the normalized section key or null
 * on malformed input.
 *
 * Quoted subsections are case-sensitive; dot-notation subsections are
 * lowercased (case-insensitive matching, like real git).
 */
function parseSectionHeader(line: string): string | null {
	let pos = 1; // skip '['

	let section = "";
	while (pos < line.length) {
		const ch = line[pos]!;
		if (ch === "]" || ch === " " || ch === "\t" || ch === '"') break;
		if (ch === ".") {
			// Dot-notation subsection: [section.subsection]
			pos++;
			let subsection = "";
			while (pos < line.length && line[pos] !== "]") {
				subsection += line[pos];
				pos++;
			}
			return `${section.toLowerCase()} "${subsection.toLowerCase()}"`;
		}
		section += ch;
		pos++;
	}

	section = section.toLowerCase();
	if (!section) return null;

	// Skip whitespace between section name and subsection
	while (pos < line.length && (line[pos] === " " || line[pos] === "\t")) pos++;

	if (pos < line.length && line[pos] === '"') {
		// Quoted subsection: [section "subsection"]
		pos++;
		let subsection = "";
		while (pos < line.length && line[pos] !== '"') {
			if (line[pos] === "\\" && pos + 1 < line.length) {
				subsection += line[pos + 1];
				pos += 2;
			} else {
				subsection += line[pos];
				pos++;
			}
		}
		return `${section} "${subsection}"`;
	}

	return section;
}

/**
 * Parse a config value following the `=` sign, matching real git's
 * semantics: double-quote toggling, escape sequences (`\\`, `\"`,
 * `\n`, `\t`, `\b`), backslash-newline continuation, inline comments
 * (`#`/`;` outside quotes), and trailing-whitespace trimming via a
 * pending-space approach.
 */
function parseValue(
	rawAfterEq: string,
	allLines: string[],
	startLineIdx: number,
): { value: string; linesConsumed: number } {
	let result = "";
	let inQuotes = false;
	let pendingSpace = 0;
	let hasContent = false;
	let lineIdx = startLineIdx;
	let raw = rawAfterEq;
	let pos = 0;

	outer: while (true) {
		while (pos < raw.length) {
			const ch = raw[pos]!;

			if (ch === "\r") {
				pos++;
				continue;
			}

			if (!inQuotes && (ch === "#" || ch === ";")) break outer;

			if (!inQuotes && (ch === " " || ch === "\t")) {
				if (hasContent) pendingSpace++;
				pos++;
				continue;
			}

			if (ch === '"') {
				flushSpace();
				inQuotes = !inQuotes;
				pos++;
				continue;
			}

			if (ch === "\\") {
				if (pos + 1 >= raw.length) {
					lineIdx++;
					if (lineIdx < allLines.length) {
						raw = allLines[lineIdx]!;
						pos = 0;
						continue;
					}
					break outer;
				}
				const next = raw[pos + 1]!;
				flushSpace();
				switch (next) {
					case "\\":
						result += "\\";
						break;
					case '"':
						result += '"';
						break;
					case "n":
						result += "\n";
						break;
					case "t":
						result += "\t";
						break;
					case "b":
						result += "\b";
						break;
					default:
						result += "\\";
						result += next;
						break;
				}
				hasContent = true;
				pos += 2;
				continue;
			}

			flushSpace();
			result += ch;
			hasContent = true;
			pos++;
		}

		break;
	}

	return { value: result, linesConsumed: lineIdx - startLineIdx + 1 };

	function flushSpace() {
		while (pendingSpace > 0) {
			result += " ";
			pendingSpace--;
		}
	}
}

/** Parse a Git config file string into a GitConfig object. */
export function parseConfig(text: string): GitConfig {
	const config: GitConfig = {};
	let currentSection: string | null = null;
	const lines = text.split("\n");
	let i = 0;

	while (i < lines.length) {
		const rawLine = lines[i]!;
		const trimmed = rawLine.trim();

		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
			i++;
			continue;
		}

		if (trimmed.startsWith("[")) {
			currentSection = parseSectionHeader(trimmed);
			if (currentSection !== null && !(currentSection in config)) {
				config[currentSection] = {};
			}
			i++;
			continue;
		}

		if (currentSection !== null) {
			const entries = config[currentSection];
			if (!entries) {
				i++;
				continue;
			}
			const eqIdx = trimmed.indexOf("=");
			if (eqIdx === -1) {
				entries[trimmed.toLowerCase()] = "true";
				i++;
			} else {
				const key = trimmed.slice(0, eqIdx).trim().toLowerCase();
				const rawValue = trimmed.slice(eqIdx + 1);
				const { value, linesConsumed } = parseValue(rawValue, lines, i);
				entries[key] = value;
				i += linesConsumed;
			}
			continue;
		}

		i++;
	}

	return config;
}

// ── Value formatting ────────────────────────────────────────────────

/**
 * Format a config value for writing, matching real git's quoting and
 * escaping rules. Always escapes `\` and `"`.  Wraps in double quotes
 * when the value contains comment chars, leading/trailing whitespace,
 * or control characters.
 */
export function formatConfigValue(value: string): string {
	const needsQuoting = /[\n\t\b#;"]/.test(value) || value !== value.trim();

	let escaped = "";
	for (let i = 0; i < value.length; i++) {
		const ch = value[i]!;
		switch (ch) {
			case "\\":
				escaped += "\\\\";
				break;
			case '"':
				escaped += '\\"';
				break;
			case "\n":
				escaped += "\\n";
				break;
			case "\t":
				escaped += "\\t";
				break;
			case "\b":
				escaped += "\\b";
				break;
			default:
				escaped += ch;
		}
	}

	return needsQuoting ? `"${escaped}"` : escaped;
}

/** Serialize a GitConfig object to the INI-like format. */
export function serializeConfig(config: GitConfig): string {
	const lines: string[] = [];

	for (const [section, entries] of Object.entries(config)) {
		lines.push(`[${section}]`);
		for (const [key, value] of Object.entries(entries)) {
			lines.push(`\t${key} = ${formatConfigValue(value)}`);
		}
	}

	return `${lines.join("\n")}\n`;
}

// ── Raw text editing ────────────────────────────────────────────────

/**
 * Scan raw config lines to locate a section/key.  Returns:
 * - `keyStart`/`keyEnd`: line range of the existing key (or -1)
 * - `insertAfter`: line after which a new key should be inserted
 *    (last key in the last matching section block, or the section
 *    header if section has no keys; -1 if section not found)
 * - `sectionHeaderLine`: line of the last matching section header (-1 if not found)
 * - `sectionHasOtherKeys`: whether the section has keys besides the target
 */
function scanForKey(
	lines: string[],
	targetSection: string,
	targetKey: string,
): {
	keyStart: number;
	keyEnd: number;
	insertAfter: number;
	sectionHeaderLine: number;
	sectionHasOtherKeys: boolean;
} {
	let currentSection: string | null = null;
	let keyStart = -1;
	let keyEnd = -1;
	let insertAfter = -1;
	let sectionHeaderLine = -1;
	let sectionHasOtherKeys = false;
	let i = 0;

	while (i < lines.length) {
		const trimmed = lines[i]!.trim();

		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
			i++;
			continue;
		}

		if (trimmed.startsWith("[")) {
			currentSection = parseSectionHeader(trimmed);
			if (currentSection === targetSection) {
				sectionHeaderLine = i;
				insertAfter = i;
				sectionHasOtherKeys = false;
			}
			i++;
			continue;
		}

		// Find extent of this key=value (including continuation lines)
		let end = i;
		while (end < lines.length - 1 && lines[end]!.replace(/\r$/, "").endsWith("\\")) {
			end++;
		}

		if (currentSection === targetSection) {
			const eqIdx = trimmed.indexOf("=");
			const lineKey =
				eqIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, eqIdx).trim().toLowerCase();

			if (lineKey === targetKey) {
				keyStart = i;
				keyEnd = end;
			} else {
				sectionHasOtherKeys = true;
			}
			insertAfter = end;
		}

		i = end + 1;
	}

	return { keyStart, keyEnd, insertAfter, sectionHeaderLine, sectionHasOtherKeys };
}

/**
 * Surgically set a key in raw config text. Returns the modified text.
 * If the key exists, replaces it in place. If the section exists but
 * the key doesn't, appends the key to the section. If the section
 * doesn't exist, appends both.
 */
export function setConfigValueRaw(
	text: string,
	sectionKey: string,
	key: string,
	value: string,
): string {
	const lines = text.split("\n");
	const scan = scanForKey(lines, sectionKey, key);
	const formatted = `\t${key} = ${formatConfigValue(value)}`;

	if (scan.keyStart !== -1) {
		lines.splice(scan.keyStart, scan.keyEnd - scan.keyStart + 1, formatted);
	} else if (scan.insertAfter !== -1) {
		lines.splice(scan.insertAfter + 1, 0, formatted);
	} else {
		// Append new section.  Ensure a blank line separator if the file
		// has existing content (don't add one for empty/whitespace-only files).
		const hasContent = lines.some((l) => l.trim().length > 0);
		if (hasContent && lines.length > 0 && lines[lines.length - 1]!.trim() !== "") {
			lines.push("");
		}
		lines.push(`[${sectionKey}]`, formatted);
	}

	return lines.join("\n");
}

/**
 * Surgically remove a key from raw config text. Returns the modified
 * text and whether the key was found. Removes the section header too
 * if the section becomes empty.
 */
export function unsetConfigValueRaw(
	text: string,
	sectionKey: string,
	key: string,
): { text: string; found: boolean } {
	const lines = text.split("\n");
	const scan = scanForKey(lines, sectionKey, key);

	if (scan.keyStart === -1) {
		return { text, found: false };
	}

	// Remove the key line(s)
	lines.splice(scan.keyStart, scan.keyEnd - scan.keyStart + 1);

	// If section is now empty, remove the header too
	if (!scan.sectionHasOtherKeys && scan.sectionHeaderLine !== -1) {
		// Header line index shifted if key was before it (shouldn't happen,
		// but be safe).  Key is always after header, so header index is stable.
		lines.splice(scan.sectionHeaderLine, 1);
	}

	return { text: lines.join("\n"), found: true };
}

// ── Filesystem operations ───────────────────────────────────────────

/** Read and parse .git/config. Returns empty config if file doesn't exist. */
export async function readConfig(ctx: GitContext): Promise<GitConfig> {
	const path = join(ctx.gitDir, "config");
	if (!(await ctx.fs.exists(path))) return {};
	const text = await ctx.fs.readFile(path);
	return parseConfig(text);
}

/** Read raw .git/config text. Returns empty string if file doesn't exist. */
async function readConfigRaw(ctx: GitContext): Promise<string> {
	const path = join(ctx.gitDir, "config");
	if (!(await ctx.fs.exists(path))) return "";
	return ctx.fs.readFile(path);
}

/** Serialize and write .git/config. */
export async function writeConfig(ctx: GitContext, config: GitConfig): Promise<void> {
	const path = join(ctx.gitDir, "config");
	await ctx.fs.writeFile(path, serializeConfig(config));
}

/**
 * Get a single config value by dotted key.
 * Key format: "section.key" or 'section "subsection".key'
 *
 * For simple sections: "core.bare" → section="core", key="bare"
 * For subsections: 'remote.origin.url' → section='remote "origin"', key="url"
 */
export async function getConfigValue(
	ctx: GitContext,
	dottedKey: string,
): Promise<string | undefined> {
	const config = await readConfig(ctx);
	const { section, key } = parseDottedKey(dottedKey);
	return config[section]?.[key];
}

/**
 * Set a single config value by dotted key. Creates section if needed.
 * Uses format-preserving raw text editing to avoid destroying comments,
 * formatting, and other entries.
 */
export async function setConfigValue(
	ctx: GitContext,
	dottedKey: string,
	value: string,
): Promise<void> {
	const raw = await readConfigRaw(ctx);
	const { section, key } = parseDottedKey(dottedKey);
	const updated = setConfigValueRaw(raw, section, key, value);
	const path = join(ctx.gitDir, "config");
	await ctx.fs.writeFile(path, updated);
}

/**
 * Unset a single config value by dotted key. Returns false if key was
 * not found. Uses format-preserving raw text editing.
 */
export async function unsetConfigValue(ctx: GitContext, dottedKey: string): Promise<boolean> {
	const raw = await readConfigRaw(ctx);
	const { section, key } = parseDottedKey(dottedKey);
	const result = unsetConfigValueRaw(raw, section, key);
	if (!result.found) return false;
	const path = join(ctx.gitDir, "config");
	await ctx.fs.writeFile(path, result.text);
	return true;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse a dotted key into section + key.
 *
 * "core.bare"          → { section: "core", key: "bare" }
 * "remote.origin.url"  → { section: 'remote "origin"', key: "url" }
 * "user.name"          → { section: "user", key: "name" }
 */
function parseDottedKey(dottedKey: string): {
	section: string;
	key: string;
} {
	const parts = dottedKey.split(".");

	if (parts.length === 2) {
		const [section = "", key = ""] = parts;
		return { section, key: key.toLowerCase() };
	}

	if (parts.length === 3) {
		// Three-part key: section.subsection.key → section "subsection"
		const [sectionName = "", subsection = "", key = ""] = parts;
		return {
			section: `${sectionName} "${subsection}"`,
			key: key.toLowerCase(),
		};
	}

	throw new Error(`Invalid config key: "${dottedKey}"`);
}
