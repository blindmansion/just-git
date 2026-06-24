import type { GitRepo, RepoCapabilities } from "./types.ts";

/**
 * Shallow per-field merge of two capability bags. Override keys win per
 * field; keys whose override value is `undefined` fall through to the base.
 *
 * Returns `undefined` only when both inputs are absent, so callers can
 * round-trip a "no capabilities" handle without materializing an empty bag.
 *
 * This is the additive first-cut policy (override-wins everywhere). A later
 * phase switches it to compose `hooks` and deep-merge `config` once wrapping
 * is the only override path.
 */
export function mergeCapabilities(
	base?: RepoCapabilities,
	override?: RepoCapabilities,
): RepoCapabilities | undefined {
	if (!base) return override;
	if (!override) return base;

	const defined: Partial<RepoCapabilities> = {};
	for (const key of Object.keys(override) as Array<keyof RepoCapabilities>) {
		if (override[key] !== undefined) {
			(defined as Record<string, unknown>)[key] = override[key];
		}
	}
	return { ...base, ...defined };
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
