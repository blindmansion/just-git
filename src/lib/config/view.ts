// Config views + capability context: the read-oriented {@link ConfigView}
// projections (sync over an in-memory snapshot, or async over a handle) and the
// {@link CapabilityContext} snapshot handed to host capability code. Sits above
// both the pure {@link parse} leaf and the {@link store} filesystem layer.

import { createAttributesProvider, emptyAttributesProvider } from "../attributes/attributes.ts";
import type { CapabilityContext, ConfigView, GitContext, GitOperation, GitRepo } from "../types.ts";
import {
	type ConfigData,
	type GitConfigMulti,
	isGitContext,
	parseConfigMulti,
	tryParseDottedKey,
} from "./parse.ts";
import { readConfigMulti, type ConfigOverrides } from "./store.ts";

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

/** Build a {@link ConfigView} over a materialized {@link ConfigData}. */
export function configViewFrom(data: ConfigData, overrides?: ConfigOverrides): ConfigView {
	return makeConfigView(parseConfigMulti(data.text), overrides);
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
