import type { ConfigOverrides } from "../hooks.ts";
import { createAttributesProvider, emptyAttributesProvider } from "./attributes/attributes.ts";
import { join } from "./path.ts";
import type { CapabilityContext, ConfigView, GitContext, GitOperation, GitRepo } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

export type GitConfigSection = Record<string, string>;
export type GitConfig = Record<string, GitConfigSection>;

export type GitConfigMultiSection = Record<string, string[]>;
export type GitConfigMulti = Record<string, GitConfigMultiSection>;

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

/**
 * Parse a Git config file, preserving all values for duplicate keys.
 * Unlike `parseConfig` (which keeps only the last value), this returns
 * arrays of values for every key, enabling `--get-all` semantics.
 */
export function parseConfigMulti(text: string): GitConfigMulti {
	const config: GitConfigMulti = {};
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
				const key = trimmed.toLowerCase();
				if (key in entries) entries[key]!.push("true");
				else entries[key] = ["true"];
				i++;
			} else {
				const key = trimmed.slice(0, eqIdx).trim().toLowerCase();
				const rawValue = trimmed.slice(eqIdx + 1);
				const { value, linesConsumed } = parseValue(rawValue, lines, i);
				if (key in entries) entries[key]!.push(value);
				else entries[key] = [value];
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

// ── ConfigData: the bounded value-state for config ──────────────────

/**
 * Materialized, format-preserving config value.
 *
 * The raw `.git/config` text is the source of truth (parsed views are
 * derived on demand), so that the pure transforms below preserve
 * comments, formatting, and entry ordering exactly like real git.
 *
 * This is the "bounded value-state" that lets config operations run on a
 * plain {@link GitRepo}: the imperative shell {@link readConfigData
 * materializes} it from the filesystem, pure functions transform it, and
 * the shell {@link writeConfigData persists} the result.
 */
export interface ConfigData {
	/** Raw text of `.git/config` (the format-preserving source of truth). */
	readonly text: string;
}

/** Wrap raw config text as a {@link ConfigData} value. */
export function configDataFromText(text: string): ConfigData {
	return { text };
}

// ── Pure readers (value in, data out) ───────────────────────────────

/**
 * Resolve a single config value from a materialized {@link ConfigData},
 * applying the same precedence as the filesystem-backed
 * {@link getConfigValue}: `locked` override wins, then the on-disk value,
 * then a `defaults` fallback.
 */
export function getConfigFrom(
	data: ConfigData,
	overrides: ConfigOverrides | undefined,
	dottedKey: string,
): string | undefined {
	const locked = overrides?.locked?.[dottedKey];
	if (locked !== undefined) return locked;

	const config = parseConfig(data.text);
	const { section, key } = parseDottedKey(dottedKey);
	const fromFile = config[section]?.[key];
	if (fromFile !== undefined) return fromFile;

	return overrides?.defaults?.[dottedKey];
}

/**
 * Resolve all values for a multi-value config key from a materialized
 * {@link ConfigData}. Mirrors {@link getConfigValueAll}'s precedence.
 */
export function getConfigAllFrom(
	data: ConfigData,
	overrides: ConfigOverrides | undefined,
	dottedKey: string,
): string[] {
	const locked = overrides?.locked?.[dottedKey];
	if (locked !== undefined) return [locked];

	if (data.text) {
		const config = parseConfigMulti(data.text);
		const { section, key } = parseDottedKey(dottedKey);
		const fromFile = config[section]?.[key];
		if (fromFile && fromFile.length > 0) return fromFile;
	}

	const def = overrides?.defaults?.[dottedKey];
	if (def !== undefined) return [def];
	return [];
}

/** Build a {@link ConfigView} over a materialized {@link ConfigData}. */
export function configViewFrom(data: ConfigData, overrides?: ConfigOverrides): ConfigView {
	return makeConfigView(parseConfigMulti(data.text), overrides);
}

// ── Pure transforms ((ConfigData, args) → ConfigData) ───────────────

/**
 * Set a single config value by dotted key (creates the section if
 * needed), returning new {@link ConfigData}. Format-preserving.
 */
export function setConfig(data: ConfigData, dottedKey: string, value: string): ConfigData {
	const { section, key } = parseDottedKey(dottedKey);
	return { text: setConfigValueRaw(data.text, section, key, value) };
}

/**
 * Append a config value by dotted key without replacing existing values
 * (`git config --add`), returning new {@link ConfigData}.
 */
export function addConfig(data: ConfigData, dottedKey: string, value: string): ConfigData {
	const { section, key } = parseDottedKey(dottedKey);
	return { text: addConfigValueRaw(data.text, section, key, value) };
}

/**
 * Unset a single config value by dotted key, returning new
 * {@link ConfigData} and whether the key was found.
 */
export function unsetConfig(
	data: ConfigData,
	dottedKey: string,
): { data: ConfigData; found: boolean } {
	const { section, key } = parseDottedKey(dottedKey);
	const { text, found } = unsetConfigValueRaw(data.text, section, key);
	return { data: { text }, found };
}

// ── Filesystem boundary (materialize / persist) ─────────────────────

/**
 * Materialize {@link ConfigData} from `.git/config`. Returns empty text
 * if the file doesn't exist. This is the imperative-shell read boundary.
 */
export async function readConfigData(ctx: GitContext): Promise<ConfigData> {
	return { text: await readConfigRaw(ctx) };
}

/** Persist {@link ConfigData} to `.git/config`. The shell write boundary. */
export async function writeConfigData(ctx: GitContext, data: ConfigData): Promise<void> {
	await ctx.fs.writeFile(join(ctx.commonDir, "config"), data.text);
}

// ── Filesystem operations ───────────────────────────────────────────

/** Read and parse .git/config. Returns empty config if file doesn't exist. */
export async function readConfig(ctx: GitContext): Promise<GitConfig> {
	return parseConfig((await readConfigData(ctx)).text);
}

/** Read raw .git/config text. Returns empty string if file doesn't exist. */
async function readConfigRaw(ctx: GitContext): Promise<string> {
	const path = join(ctx.commonDir, "config");
	if (!(await ctx.fs.exists(path))) return "";
	return ctx.fs.readFile(path);
}

/** Serialize and write .git/config. */
export async function writeConfig(ctx: GitContext, config: GitConfig): Promise<void> {
	const path = join(ctx.commonDir, "config");
	await ctx.fs.writeFile(path, serializeConfig(config));
}

/**
 * Get a single config value by dotted key.
 * Key format: "section.key" or 'section "subsection".key'
 *
 * For simple sections: "core.bare" → section="core", key="bare"
 * For subsections: 'remote.origin.url' → section='remote "origin"', key="url"
 *
 * Respects operator-level config overrides on `ctx.capabilities.config`:
 *   1. `locked` values always win
 *   2. `.git/config` value
 *   3. `defaults` fallback
 *
 * Imperative-shell wrapper over the pure {@link getConfigFrom}: a `locked`
 * override short-circuits the filesystem read entirely.
 */
export async function getConfigValue(
	ctx: GitContext,
	dottedKey: string,
): Promise<string | undefined> {
	const overrides = ctx.capabilities?.config;
	const locked = overrides?.locked?.[dottedKey];
	if (locked !== undefined) return locked;

	return getConfigFrom(await readConfigData(ctx), overrides, dottedKey);
}

/**
 * Set a single config value by dotted key. Creates section if needed.
 * Uses format-preserving raw text editing to avoid destroying comments,
 * formatting, and other entries.
 *
 * Imperative-shell wrapper: materialize → {@link setConfig} → persist.
 */
export async function setConfigValue(
	ctx: GitContext,
	dottedKey: string,
	value: string,
): Promise<void> {
	await writeConfigData(ctx, setConfig(await readConfigData(ctx), dottedKey, value));
}

/**
 * Get all values for a multi-value config key.
 * Returns an empty array if the key doesn't exist.
 *
 * Respects operator-level locked overrides (returns `[lockedValue]`
 * when set, ignoring on-disk values) and defaults.
 *
 * Imperative-shell wrapper over the pure {@link getConfigAllFrom}: a
 * `locked` override short-circuits the filesystem read entirely.
 */
export async function getConfigValueAll(ctx: GitContext, dottedKey: string): Promise<string[]> {
	const overrides = ctx.capabilities?.config;
	const locked = overrides?.locked?.[dottedKey];
	if (locked !== undefined) return [locked];

	return getConfigAllFrom(await readConfigData(ctx), overrides, dottedKey);
}

// ── Capability context ──────────────────────────────────────────────

/**
 * Build a synchronous {@link ConfigView} over an in-memory config snapshot,
 * applying the same precedence as {@link getConfigValue} / {@link
 * getConfigValueAll}: a `locked` override wins, then the on-disk value(s), then
 * a `defaults` fallback. An unparseable dotted key resolves to "no value"
 * rather than throwing, since the view is handed to host capability code.
 */
export function makeConfigView(disk: GitConfigMulti, overrides?: ConfigOverrides): ConfigView {
	return {
		get(dottedKey) {
			const locked = overrides?.locked?.[dottedKey];
			if (locked !== undefined) return locked;
			const parsed = tryParseDottedKey(dottedKey);
			const values = parsed && disk[parsed.section]?.[parsed.key];
			if (values && values.length > 0) return values[values.length - 1];
			return overrides?.defaults?.[dottedKey];
		},
		getAll(dottedKey) {
			const locked = overrides?.locked?.[dottedKey];
			if (locked !== undefined) return [locked];
			const parsed = tryParseDottedKey(dottedKey);
			const values = parsed && disk[parsed.section]?.[parsed.key];
			if (values && values.length > 0) return [...values];
			const def = overrides?.defaults?.[dottedKey];
			return def !== undefined ? [def] : [];
		},
	};
}

/** Read and parse .git/config preserving duplicate keys. Empty if no file. */
export async function readConfigMulti(ctx: GitContext): Promise<GitConfigMulti> {
	const raw = await readConfigRaw(ctx);
	return raw ? parseConfigMulti(raw) : {};
}

/**
 * Build a {@link ConfigView} for any handle: reads `.git/config` when the
 * handle is filesystem-backed and layers operator overrides either way. The
 * async, handle-shaped counterpart to {@link makeConfigView} — the config half
 * of {@link buildCapabilityContext}, exposed for resolvers that need an
 * effective config view without a full {@link CapabilityContext} (and that must
 * tolerate a bare, store-backed handle without an fs).
 */
export async function readConfigView(handle: GitRepo | GitContext): Promise<ConfigView> {
	const overrides = handle.capabilities?.config;
	const disk = isGitContext(handle) ? await readConfigMulti(handle) : {};
	return makeConfigView(disk, overrides);
}

/**
 * Snapshot a handle into a {@link CapabilityContext} for the function-shaped
 * capabilities. Reads `.git/config` once (when the handle is filesystem-backed)
 * to back a synchronous {@link ConfigView}; a bare store-backed handle gets an
 * empty view layered only with the static overrides. Identity is intentionally
 * not resolved here — it is not part of the context.
 */
export async function buildCapabilityContext(
	handle: GitRepo | GitContext,
	operation: GitOperation,
	opts?: { env?: ReadonlyMap<string, string>; url?: string },
): Promise<CapabilityContext> {
	const overrides = handle.capabilities?.config;
	const fsBound = isGitContext(handle);
	const disk = fsBound ? await readConfigMulti(handle) : {};
	return {
		operation,
		repo: {
			gitDir: fsBound ? handle.gitDir : undefined,
			objectStore: handle.objectStore,
			refStore: handle.refStore,
		},
		config: makeConfigView(disk, overrides),
		attributes: fsBound ? createAttributesProvider(handle) : emptyAttributesProvider,
		env: opts?.env,
		url: opts?.url,
	};
}

export function isGitContext(handle: GitRepo | GitContext): handle is GitContext {
	return "fs" in handle && "gitDir" in handle;
}

/**
 * Surgically append a value to a key in raw config text, without
 * replacing any existing values. If the section doesn't exist, it is
 * created. This is the raw-text equivalent of `git config --add`.
 */
export function addConfigValueRaw(
	text: string,
	sectionKey: string,
	key: string,
	value: string,
): string {
	const lines = text.split("\n");
	const scan = scanForKey(lines, sectionKey, key);
	const formatted = `\t${key} = ${formatConfigValue(value)}`;

	if (scan.insertAfter !== -1) {
		lines.splice(scan.insertAfter + 1, 0, formatted);
	} else {
		const hasContent = lines.some((l) => l.trim().length > 0);
		if (hasContent && lines.length > 0 && lines[lines.length - 1]!.trim() !== "") {
			lines.push("");
		}
		lines.push(`[${sectionKey}]`, formatted);
	}

	return lines.join("\n");
}

/**
 * Append a config value by dotted key, without replacing existing values.
 * This is the high-level equivalent of `git config --add`.
 *
 * Imperative-shell wrapper: materialize → {@link addConfig} → persist.
 */
export async function addConfigValue(
	ctx: GitContext,
	dottedKey: string,
	value: string,
): Promise<void> {
	await writeConfigData(ctx, addConfig(await readConfigData(ctx), dottedKey, value));
}

/**
 * Unset a single config value by dotted key. Returns false if key was
 * not found. Uses format-preserving raw text editing.
 *
 * Imperative-shell wrapper: materialize → {@link unsetConfig} → persist.
 */
export async function unsetConfigValue(ctx: GitContext, dottedKey: string): Promise<boolean> {
	const { data, found } = unsetConfig(await readConfigData(ctx), dottedKey);
	if (!found) return false;
	await writeConfigData(ctx, data);
	return true;
}

/**
 * Normalize a config value to a boolean using git's truthiness rules.
 *
 * `true`/`yes`/`on`/`1` and a bare valueless key (stored as `""`) are
 * `true`; `false`/`no`/`off`/`0` are `false`. Anything else (and
 * `undefined`) returns `undefined`, leaving the caller to decide — e.g.
 * fall back to a per-call flag or a hard-coded default. Lets
 * `commit.gpgsign=false` and `--no-gpg-sign` share one code path instead
 * of ad-hoc `=== "true"` checks.
 */
export function configBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const s = value.trim().toLowerCase();
	if (s === "true" || s === "yes" || s === "on" || s === "1" || s === "") return true;
	if (s === "false" || s === "no" || s === "off" || s === "0") return false;
	return undefined;
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

/** Like {@link parseDottedKey} but returns null instead of throwing. */
function tryParseDottedKey(dottedKey: string): { section: string; key: string } | null {
	try {
		return parseDottedKey(dottedKey);
	} catch {
		return null;
	}
}
