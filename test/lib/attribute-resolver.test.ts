import { describe, expect, test } from "bun:test";
import {
	type DiffDriver,
	everyPath,
	gitAttributes,
	pipeAttributes,
} from "../../src/lib/attributes/attribute-resolver.ts";
import type { AttrValue } from "../../src/lib/attributes/attributes.ts";
import type { FilterDriver } from "../../src/lib/attributes/filters.ts";
import type { MergeDriver } from "../../src/lib/merge-ort.ts";
import type { CapabilityContext } from "../../src/lib/types.ts";

const enc = new TextEncoder();

// pipeAttributes never touches ctx for these resolvers; a bare cast is enough.
const ctx = {} as CapabilityContext;

const filterA: FilterDriver = { clean: (_c, i) => i.content };
const filterB: FilterDriver = { clean: () => enc.encode("b") };
const mergeA: MergeDriver = () => ({ content: enc.encode("a"), conflict: false });

describe("pipeAttributes", () => {
	test("first resolver to set a field wins", async () => {
		const resolver = pipeAttributes(everyPath({ filter: filterA }), everyPath({ filter: filterB }));
		const resolved = await resolver(ctx, "x");
		expect(resolved.filter).toBe(filterA);
	});

	test("later resolvers fill fields the earlier ones leave unset", async () => {
		const resolver = pipeAttributes(everyPath({ filter: filterA }), everyPath({ merge: mergeA }));
		const resolved = await resolver(ctx, "x");
		expect(resolved.filter).toBe(filterA);
		expect(resolved.merge).toBe(mergeA);
	});

	test("composes a computed (host) resolver over a per-path one", async () => {
		// Host pins `.lock` files; everything else defers to the project resolver.
		const hostLocked = (_c: CapabilityContext, path: string) =>
			path.endsWith(".lock") ? { merge: mergeA } : {};
		const project = everyPath({ filter: filterB });

		const resolver = pipeAttributes(hostLocked, project);
		const lock = await resolver(ctx, "bun.lock");
		expect(lock.merge).toBe(mergeA);
		expect(lock.filter).toBe(filterB);

		const other = await resolver(ctx, "src/a.ts");
		expect(other.merge).toBeUndefined();
		expect(other.filter).toBe(filterB);
	});

	test("empty pipe resolves to git defaults (no behaviors)", async () => {
		const resolver = pipeAttributes();
		expect(await resolver(ctx, "x")).toEqual({});
	});
});

describe("gitAttributes — diff= resolution", () => {
	const upper: DiffDriver = { textconv: (_c, i) => i.content };

	/** A ctx whose in-tree provider reports a fixed value for the `diff` attribute. */
	const ctxWithDiff = (value: AttrValue): CapabilityContext =>
		({
			attributes: {
				get: async (_p: string, attr: string) => (attr === "diff" ? value : undefined),
				getAll: async () => new Map(),
			},
		}) as unknown as CapabilityContext;

	test("diff=<name> selects the registered driver", async () => {
		const resolver = gitAttributes({ diffDrivers: { upper } });
		expect((await resolver(ctxWithDiff("upper"), "f.txt")).diff).toBe(upper);
	});

	test("diff=<unknown> is passthrough (no driver)", async () => {
		const resolver = gitAttributes({ diffDrivers: { upper } });
		expect((await resolver(ctxWithDiff("nope"), "f.txt")).diff).toBeUndefined();
	});

	test("-diff (false) maps to a force-binary driver", async () => {
		const resolver = gitAttributes({});
		expect((await resolver(ctxWithDiff(false), "f.txt")).diff).toEqual({ binary: true });
	});

	test("diff (true) maps to a force-textual driver", async () => {
		const resolver = gitAttributes({});
		expect((await resolver(ctxWithDiff(true), "f.txt")).diff).toEqual({ binary: false });
	});

	test("unspecified diff resolves to no driver", async () => {
		const resolver = gitAttributes({ diffDrivers: { upper } });
		expect((await resolver(ctxWithDiff(undefined), "f.txt")).diff).toBeUndefined();
	});
});
