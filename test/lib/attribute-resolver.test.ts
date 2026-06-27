import { describe, expect, test } from "bun:test";
import { everyPath, pipeAttributes } from "../../src/lib/attribute-resolver.ts";
import type { FilterDriver } from "../../src/lib/filters.ts";
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
