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

/** Serialize a GitConfig object back to the INI-like format. */
export function serializeConfig(config: GitConfig): string {
	const lines: string[] = [];

	for (const [section, entries] of Object.entries(config)) {
		lines.push(`[${section}]`);
		for (const [key, value] of Object.entries(entries)) {
			lines.push(`\t${key} = ${value}`);
		}
	}

	return `${lines.join("\n")}\n`;
}

// ── Filesystem operations ───────────────────────────────────────────

/** Read and parse .git/config. Returns empty config if file doesn't exist. */
export async function readConfig(ctx: GitContext): Promise<GitConfig> {
	const path = join(ctx.gitDir, "config");
	if (!(await ctx.fs.exists(path))) return {};
	const text = await ctx.fs.readFile(path);
	return parseConfig(text);
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

/** Set a single config value by dotted key. Creates section if needed. */
export async function setConfigValue(
	ctx: GitContext,
	dottedKey: string,
	value: string,
): Promise<void> {
	const config = await readConfig(ctx);
	const { section, key } = parseDottedKey(dottedKey);
	if (!config[section]) config[section] = {};
	config[section][key] = value;
	await writeConfig(ctx, config);
}

/** Unset a single config value by dotted key. Returns false if key was not found. */
export async function unsetConfigValue(ctx: GitContext, dottedKey: string): Promise<boolean> {
	const config = await readConfig(ctx);
	const { section, key } = parseDottedKey(dottedKey);
	if (!config[section]?.[key]) return false;
	delete config[section][key];
	if (Object.keys(config[section]).length === 0) delete config[section];
	await writeConfig(ctx, config);
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
