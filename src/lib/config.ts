import { join } from "./path.ts";
import type { GitContext } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Git config is INI-like with sections and optional subsections:
 *
 *   [core]
 *       repositoryformatversion = 0
 *       bare = false
 *   [remote "origin"]
 *       url = https://example.com/repo.git
 *
 * We represent this as a nested map:
 *   { "core": { "repositoryformatversion": "0", "bare": "false" },
 *     'remote "origin"': { "url": "https://example.com/repo.git" } }
 */
export type GitConfigSection = Record<string, string>;
export type GitConfig = Record<string, GitConfigSection>;

// ── Parsing ─────────────────────────────────────────────────────────

/** Parse a Git config file string into a GitConfig object. */
function parseConfig(text: string): GitConfig {
	const config: GitConfig = {};
	let currentSection: string | null = null;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();

		// Skip empty lines and comments
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;

		// Section header: [section] or [section "subsection"]
		if (line.startsWith("[")) {
			const close = line.indexOf("]");
			if (close === -1) continue;
			currentSection = line.slice(1, close).trim();
			if (!(currentSection in config)) {
				config[currentSection] = {};
			}
			continue;
		}

		// Key = value pair
		if (currentSection !== null) {
			const entries = config[currentSection];
			if (!entries) continue;
			const eqIdx = line.indexOf("=");
			if (eqIdx === -1) {
				// Boolean key with no value (e.g. "bare" alone means true)
				const key = line.trim().toLowerCase();
				entries[key] = "true";
			} else {
				const key = line.slice(0, eqIdx).trim().toLowerCase();
				const value = line.slice(eqIdx + 1).trim();
				entries[key] = value;
			}
		}
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
