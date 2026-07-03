import type { ConfigOverrides } from "../hooks.ts";
import { composeGitHooks } from "./hooks.ts";
import type { GitRepo, RepoCapabilities } from "./types.ts";

/**
 * Deep-merge two config-override bags. `locked` and `defaults` are merged
 * per-key with the override winning; a key only present on the base survives.
 * Returns `undefined` only when both inputs are absent.
 */
function mergeConfigOverrides(
	base?: ConfigOverrides,
	override?: ConfigOverrides,
): ConfigOverrides | undefined {
	if (!base) return override;
	if (!override) return base;

	const locked = { ...base.locked, ...override.locked };
	const defaults = { ...base.defaults, ...override.defaults };

	const merged: ConfigOverrides = {};
	if (Object.keys(locked).length > 0) merged.locked = locked;
	if (Object.keys(defaults).length > 0) merged.defaults = defaults;
	return merged;
}

/**
 * Per-field merge of two capability bags, layering an override onto a base.
 *
 * Most fields are override-wins: a defined override value replaces the base,
 * while an `undefined` (or absent) override key falls through to the base. Two
 * fields combine instead of replace, since wrapping should never silently
 * disable what the base already provided:
 *
 * - `hooks` — composed via {@link composeGitHooks} (both sets fire; pre-hooks
 *   chain base-first and short-circuit on the first rejection).
 * - `config` — deep-merged per key (override wins per key; base-only keys
 *   survive).
 *
 * The `attributes` resolver is override-wins like the rest: a wrapping resolver
 * replaces the base's. To layer instead of replace, compose them outside (e.g.
 * `pipeAttributes(base, override)`) before attaching.
 *
 * Returns `undefined` only when both inputs are absent, so callers can
 * round-trip a "no capabilities" handle without materializing an empty bag.
 */
export function mergeCapabilities(
	base?: RepoCapabilities,
	override?: RepoCapabilities,
): RepoCapabilities | undefined {
	if (!base) return override;
	if (!override) return base;

	const merged: RepoCapabilities = { ...base };
	for (const key of Object.keys(override) as Array<keyof RepoCapabilities>) {
		const value = override[key];
		if (value !== undefined) {
			(merged as Record<string, unknown>)[key] = value;
		}
	}

	if (base.hooks && override.hooks) {
		merged.hooks = composeGitHooks(base.hooks, override.hooks);
	}
	if (base.config && override.config) {
		merged.config = mergeConfigOverrides(base.config, override.config);
	}

	return merged;
}

/**
 * Attach/merge capabilities onto a handle, preserving any already present.
 * Override keys win per field; undefined keys fall through to the base.
 *
 * The ONE blessed way to put capabilities on a repo — every factory and
 * wrapper routes through it, so a capability is never silently dropped when
 * a handle is rebuilt or wrapped. Returns the same handle unchanged when
 * `caps` is absent.
 */
export function withCapabilities<T extends GitRepo>(repo: T, caps?: RepoCapabilities): T {
	if (!caps) return repo;
	return { ...repo, capabilities: mergeCapabilities(repo.capabilities, caps) };
}

/**
 * Read the current time from the injected {@link RepoCapabilities.now} clock,
 * falling back to the system clock. The single seam every "what time is it now"
 * read routes through, so a host can make author/committer/reflog timestamps
 * deterministic by setting `now` once on the handle.
 */
export function clockNow(caps?: RepoCapabilities): Date {
	return caps?.now?.() ?? new Date();
}
