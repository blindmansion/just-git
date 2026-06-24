import { describe, expect, test } from "bun:test";
import type { ConfigOverrides, GitHooks, PreCommitEvent } from "../../src/hooks.ts";
import { mergeCapabilities, withCapabilities } from "../../src/lib/capabilities.ts";
import type { GitRepo, ObjectStore, RefStore } from "../../src/lib/types.ts";
import { overlayRepo, readonlyRepo } from "../../src/repo/safety.ts";

// Minimal stub stores — the wrapper tests below only need them to exist; no
// store method is actually invoked while checking capability preservation.
const stubObjectStore = {} as ObjectStore;
const stubRefStore = {} as RefStore;

function makeRepo(caps?: GitRepo["capabilities"]): GitRepo {
	return withCapabilities({ objectStore: stubObjectStore, refStore: stubRefStore }, caps);
}

// ── mergeCapabilities: override-wins fields ─────────────────────────

describe("mergeCapabilities override-wins fields", () => {
	test("a defined override value replaces the base", () => {
		const merged = mergeCapabilities({ network: false }, { network: { allowed: ["x"] } });
		expect(merged?.network).toEqual({ allowed: ["x"] });
	});

	test("an undefined override key falls through to the base", () => {
		const merged = mergeCapabilities({ network: false }, { network: undefined });
		expect(merged?.network).toBe(false);
	});

	test("base-only keys survive", () => {
		const resolveRemote = () => null;
		const merged = mergeCapabilities({ resolveRemote }, { network: false });
		expect(merged?.resolveRemote).toBe(resolveRemote);
		expect(merged?.network).toBe(false);
	});

	test("returns undefined only when both inputs are absent", () => {
		expect(mergeCapabilities(undefined, undefined)).toBeUndefined();
		expect(mergeCapabilities({ network: false }, undefined)).toEqual({ network: false });
		expect(mergeCapabilities(undefined, { network: false })).toEqual({ network: false });
	});
});

// ── mergeCapabilities: hooks compose ────────────────────────────────

describe("mergeCapabilities composes hooks", () => {
	test("both base and override pre-hooks fire, base first", async () => {
		const order: string[] = [];
		const base: GitHooks = {
			preCommit: () => {
				order.push("base");
			},
		};
		const override: GitHooks = {
			preCommit: () => {
				order.push("override");
			},
		};

		const merged = mergeCapabilities({ hooks: base }, { hooks: override });
		await merged?.hooks?.preCommit?.({} as PreCommitEvent);

		expect(order).toEqual(["base", "override"]);
	});

	test("override hook does not disable a base hook on a different event", async () => {
		let postFired = false;
		const base: GitHooks = {
			postCommit: () => {
				postFired = true;
			},
		};
		const override: GitHooks = { preCommit: () => {} };

		const merged = mergeCapabilities({ hooks: base }, { hooks: override });
		await merged?.hooks?.postCommit?.({} as never);

		expect(postFired).toBe(true);
	});

	test("base pre-hook rejection short-circuits before the override hook", async () => {
		let overrideFired = false;
		const base: GitHooks = {
			preCommit: () => ({ reject: true, message: "blocked" }),
		};
		const override: GitHooks = {
			preCommit: () => {
				overrideFired = true;
			},
		};

		const merged = mergeCapabilities({ hooks: base }, { hooks: override });
		const result = await merged?.hooks?.preCommit?.({} as PreCommitEvent);

		expect(result).toEqual({ reject: true, message: "blocked" });
		expect(overrideFired).toBe(false);
	});

	test("override hooks win as a plain replace when the base has none", () => {
		const override: GitHooks = { preCommit: () => {} };
		const merged = mergeCapabilities({ network: false }, { hooks: override });
		expect(merged?.hooks).toBe(override);
	});
});

// ── mergeCapabilities: config deep-merge ────────────────────────────

describe("mergeCapabilities deep-merges config", () => {
	test("locked and defaults merge per-key, override wins per key", () => {
		const base: ConfigOverrides = {
			locked: { "user.name": "base", "core.bare": "false" },
			defaults: { "push.default": "simple" },
		};
		const override: ConfigOverrides = {
			locked: { "user.name": "override" },
			defaults: { "merge.ff": "only" },
		};

		const merged = mergeCapabilities({ config: base }, { config: override });

		expect(merged?.config).toEqual({
			locked: { "user.name": "override", "core.bare": "false" },
			defaults: { "push.default": "simple", "merge.ff": "only" },
		});
	});

	test("config falls through when only one side defines it", () => {
		const base: ConfigOverrides = { locked: { "user.name": "base" } };
		const merged = mergeCapabilities({ config: base }, { network: false });
		expect(merged?.config).toBe(base);
	});
});

// ── withCapabilities ────────────────────────────────────────────────

describe("withCapabilities", () => {
	test("returns the same handle unchanged when caps are absent", () => {
		const repo = makeRepo();
		expect(withCapabilities(repo)).toBe(repo);
	});

	test("layers onto an existing bag without dropping prior fields", () => {
		const repo = makeRepo({ network: false });
		const wrapped = withCapabilities(repo, { resolveRemote: () => null });
		expect(wrapped.capabilities?.network).toBe(false);
		expect(wrapped.capabilities?.resolveRemote).toBeDefined();
	});
});

// ── wrappers preserve capabilities (Phase 4 drop-bug fix) ───────────

describe("repo wrappers preserve capabilities", () => {
	test("readonlyRepo carries capabilities forward", () => {
		const repo = makeRepo({ network: false });
		expect(readonlyRepo(repo).capabilities?.network).toBe(false);
	});

	test("overlayRepo carries capabilities forward", () => {
		const repo = makeRepo({ network: false });
		expect(overlayRepo(repo).capabilities?.network).toBe(false);
	});
});
