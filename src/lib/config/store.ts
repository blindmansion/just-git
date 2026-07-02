// Config store: the filesystem-backed read/write/get/set/unset operations plus
// the pure {@link ConfigData} transforms/readers they wrap. Each imperative
// shell (`getConfigValue`, `setConfigValue`, …) sits next to the pure function
// it materializes around (`getConfigFrom`, `setConfig`, …) so the value-state
// boundary is easy to follow. Depends only on the pure {@link parse} leaf.

import type { ConfigOverrides } from "../../hooks.ts";
import { join } from "../path.ts";
import type { GitContext } from "../types.ts";
import {
	type ConfigData,
	type GitConfig,
	type GitConfigMulti,
	addConfigValueRaw,
	parseConfig,
	parseConfigMulti,
	parseDottedKey,
	serializeConfig,
	setConfigValueRaw,
	unsetConfigValueRaw,
} from "./parse.ts";

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

/** Read and parse .git/config preserving duplicate keys. Empty if no file. */
export async function readConfigMulti(ctx: GitContext): Promise<GitConfigMulti> {
	const raw = await readConfigRaw(ctx);
	return raw ? parseConfigMulti(raw) : {};
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
