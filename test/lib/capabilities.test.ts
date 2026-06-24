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
	const idA = { name: "a", email: "a@x" };
	const idB = { name: "b", email: "b@x" };

	test("a defined override value replaces the base", () => {
		const merged = mergeCapabilities({ identity: idA }, { identity: idB });
		expect(merged?.identity).toEqual(idB);
	});

	test("an undefined override key falls through to the base", () => {
		const merged = mergeCapabilities({ identity: idA }, { identity: undefined });
		expect(merged?.identity).toBe(idA);
	});

	test("base-only keys survive", () => {
		const onProgress = () => {};
		const merged = mergeCapabilities({ onProgress }, { identity: idB });
		expect(merged?.onProgress).toBe(onProgress);
		expect(merged?.identity).toEqual(idB);
	});

	test("returns undefined only when both inputs are absent", () => {
		expect(mergeCapabilities(undefined, undefined)).toBeUndefined();
		expect(mergeCapabilities({ identity: idA }, undefined)).toEqual({ identity: idA });
		expect(mergeCapabilities(undefined, { identity: idA })).toEqual({ identity: idA });
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
		const merged = mergeCapabilities({ onProgress: () => {} }, { hooks: override });
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
		const merged = mergeCapabilities({ config: base }, { onProgress: () => {} });
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
		const onProgress = () => {};
		const repo = makeRepo({ onProgress });
		const wrapped = withCapabilities(repo, { identity: { name: "x", email: "x@y" } });
		expect(wrapped.capabilities?.onProgress).toBe(onProgress);
		expect(wrapped.capabilities?.identity).toBeDefined();
	});
});

// ── wrappers preserve capabilities (Phase 4 drop-bug fix) ───────────

describe("repo wrappers preserve capabilities", () => {
	const onProgress = () => {};

	test("readonlyRepo carries capabilities forward", () => {
		const repo = makeRepo({ onProgress });
		expect(readonlyRepo(repo).capabilities?.onProgress).toBe(onProgress);
	});

	test("overlayRepo carries capabilities forward", () => {
		const repo = makeRepo({ onProgress });
		expect(overlayRepo(repo).capabilities?.onProgress).toBe(onProgress);
	});
});
