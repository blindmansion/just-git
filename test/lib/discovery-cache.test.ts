import { describe, expect, test } from "bun:test";
import { createMemoryDiscoveryCache } from "../../src/lib/transport/discovery-cache.ts";
import { SmartHttpTransport, type FetchFunction } from "../../src/lib/transport/transport.ts";
import type { DiscoveryEntry, GitRepo } from "../../src/lib/types.ts";
import {
	buildV2CapabilityAdvertisement,
	buildV2LsRefsResponse,
} from "../../src/server/protocol.ts";

const HASH_A = "95dcfa3633004da0049d3d0fa03f80589cbcaf31";
const URL_A = "https://example.com/repo.git";

const V2_CAPS = ["agent=just-git/1.0", "ls-refs=unborn", "fetch=shallow", "object-format=sha1"];

/** A throwaway local handle; v2 `advertiseRefs` (ls-refs only) never reads it. */
const NO_LOCAL = {} as unknown as GitRepo;

function v2AdvertResponse(): Response {
	return new Response(buildV2CapabilityAdvertisement(V2_CAPS), {
		headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
	});
}

function lsRefsResponse(): Response {
	return new Response(buildV2LsRefsResponse([{ hash: HASH_A, name: "refs/heads/main" }]), {
		headers: { "Content-Type": "application/x-git-upload-pack-result" },
	});
}

interface Counts {
	infoRefs: number;
	lsRefs: number;
}

/**
 * A stateful mock fetch serving a v2 upload-pack server. `failLsRefs`, when set,
 * makes the next `ls-refs` POST 400 — cleared on the next discovery `GET`, so it
 * models a stale cache that the transport must evict + re-discover around.
 */
function mockUploadPack(): {
	fetch: FetchFunction;
	counts: Counts;
	failLsRefs: { value: boolean };
} {
	const counts: Counts = { infoRefs: 0, lsRefs: 0 };
	const failLsRefs = { value: false };
	const fetch: FetchFunction = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (url.includes("/info/refs")) {
			counts.infoRefs++;
			failLsRefs.value = false; // a fresh discovery clears the stale-cache flag
			return v2AdvertResponse();
		}
		if (url.includes("git-upload-pack") && method === "POST") {
			counts.lsRefs++;
			if (failLsRefs.value) return new Response("nope", { status: 400 });
			return lsRefsResponse();
		}
		throw new Error(`unexpected request: ${method} ${url}`);
	};
	return { fetch, counts, failLsRefs };
}

describe("createMemoryDiscoveryCache", () => {
	const entry: DiscoveryEntry = {
		protocolVersion: 2,
		uploadPack: { v2: { raw: V2_CAPS, objectFormat: "sha1" } },
		fetchedAt: 0,
	};

	test("round-trips an entry by repository URL", async () => {
		const cache = createMemoryDiscoveryCache();
		await cache.set(URL_A, entry);
		expect(await cache.get(URL_A)).toMatchObject({ protocolVersion: 2 });
		expect(await cache.get("https://example.com/other.git")).toBeUndefined();
	});

	test("treats an entry older than maxAge as a miss and drops it", async () => {
		let clock = 1000;
		const cache = createMemoryDiscoveryCache({ maxAgeMs: 100, now: () => clock });
		await cache.set("https://example.com", entry);
		expect(await cache.get("https://example.com")).toBeDefined();
		clock += 101;
		expect(await cache.get("https://example.com")).toBeUndefined();
		// A second get confirms the expired entry was evicted, not just skipped.
		clock = 0;
		expect(await cache.get("https://example.com")).toBeUndefined();
	});

	test("evict drops an entry", async () => {
		const cache = createMemoryDiscoveryCache();
		await cache.set("https://example.com", entry);
		await cache.evict?.("https://example.com");
		expect(await cache.get("https://example.com")).toBeUndefined();
	});

	test("re-stamps fetchedAt with its own clock on set", async () => {
		const cache = createMemoryDiscoveryCache({ now: () => 4242 });
		await cache.set("https://example.com", { ...entry, fetchedAt: 0 });
		expect((await cache.get("https://example.com"))?.fetchedAt).toBe(4242);
	});
});

describe("SmartHttpTransport + DiscoveryCache", () => {
	test("a cache hit suppresses the capability GET on a later transport", async () => {
		const { fetch, counts } = mockUploadPack();
		const cache = createMemoryDiscoveryCache();

		// First transport: discovery from the wire — one cap GET + one ls-refs.
		const t1 = new SmartHttpTransport(NO_LOCAL, URL_A, fetch, undefined, 2, cache);
		expect(await t1.advertiseRefs()).toEqual([{ name: "refs/heads/main", hash: HASH_A }]);
		expect(counts.infoRefs).toBe(1);
		expect(counts.lsRefs).toBe(1);

		// Second transport, same cache: caps restored from cache, GET skipped.
		const t2 = new SmartHttpTransport(NO_LOCAL, URL_A, fetch, undefined, 2, cache);
		expect(await t2.advertiseRefs()).toEqual([{ name: "refs/heads/main", hash: HASH_A }]);
		expect(counts.infoRefs).toBe(1); // unchanged — no second cap GET
		expect(counts.lsRefs).toBe(2); // refs are volatile, so ls-refs still runs
	});

	test("repositories on the same origin have separate discovery entries", async () => {
		const { fetch, counts } = mockUploadPack();
		const cache = createMemoryDiscoveryCache();

		await new SmartHttpTransport(NO_LOCAL, URL_A, fetch, undefined, 2, cache).advertiseRefs();
		await new SmartHttpTransport(
			NO_LOCAL,
			"https://example.com/other.git",
			fetch,
			undefined,
			2,
			cache,
		).advertiseRefs();

		expect(counts.infoRefs).toBe(2);
	});

	test("without a cache, every transport re-discovers", async () => {
		const { fetch, counts } = mockUploadPack();
		await new SmartHttpTransport(NO_LOCAL, URL_A, fetch).advertiseRefs();
		await new SmartHttpTransport(NO_LOCAL, URL_A, fetch).advertiseRefs();
		expect(counts.infoRefs).toBe(2);
	});

	test("a stale cached entry self-corrects: evict + re-discover once, then succeed", async () => {
		const { fetch, counts, failLsRefs } = mockUploadPack();
		const cache = createMemoryDiscoveryCache();

		// Warm the cache from a healthy first transport.
		await new SmartHttpTransport(NO_LOCAL, URL_A, fetch, undefined, 2, cache).advertiseRefs();
		expect(counts.infoRefs).toBe(1);

		// Now the cached caps are "stale": the next ls-refs POST 400s. The
		// transport must evict, re-run discovery from the wire (a fresh GET that
		// clears the failure), and retry the ls-refs — ending in success.
		failLsRefs.value = true;
		const t = new SmartHttpTransport(NO_LOCAL, URL_A, fetch, undefined, 2, cache);
		expect(await t.advertiseRefs()).toEqual([{ name: "refs/heads/main", hash: HASH_A }]);

		// One self-correcting re-discovery GET (total 2), and the failed +
		// succeeding ls-refs POSTs (warm-up 1 + failed 1 + retry 1 = 3).
		expect(counts.infoRefs).toBe(2);
		expect(counts.lsRefs).toBe(3);

		// The freshly re-discovered entry is back in the cache for the next op.
		expect(await cache.get(URL_A)).toMatchObject({ protocolVersion: 2 });
	});

	test("a cached entry claiming an unsupported object-format self-corrects", async () => {
		const { fetch, counts } = mockUploadPack();
		const cache = createMemoryDiscoveryCache();
		// Poison the cache: an entry asserting sha256, which the transport can't
		// consume. It must evict + re-discover (the wire advertises sha1) rather
		// than hard-failing.
		await cache.set(URL_A, {
			protocolVersion: 2,
			uploadPack: {
				v2: {
					raw: ["agent=just-git/1.0", "ls-refs", "object-format=sha256"],
					objectFormat: "sha256",
				},
			},
			fetchedAt: 0,
		});

		const t = new SmartHttpTransport(NO_LOCAL, URL_A, fetch, undefined, 2, cache);
		expect(await t.advertiseRefs()).toEqual([{ name: "refs/heads/main", hash: HASH_A }]);
		expect(counts.infoRefs).toBe(1); // re-discovered once from the wire
		const restored = await cache.get(URL_A);
		expect(restored?.uploadPack).toMatchObject({ v2: { objectFormat: "sha1" } });
	});

	test("seeded refs reuse a probe and skip the ls-refs POST (v2)", async () => {
		const { fetch, counts } = mockUploadPack();
		const t = new SmartHttpTransport(NO_LOCAL, URL_A, fetch);
		t.seedRefs([{ name: "refs/heads/main", hash: HASH_A }]);
		expect(await t.advertiseRefs()).toEqual([{ name: "refs/heads/main", hash: HASH_A }]);
		expect(counts.infoRefs).toBe(1); // caps are still discovered
		expect(counts.lsRefs).toBe(0); // refs came from the seed — no ls-refs
	});

	test("seed + cache hit elides both the cap GET and ls-refs", async () => {
		const { fetch, counts } = mockUploadPack();
		const cache = createMemoryDiscoveryCache();
		// Warm the cache.
		await new SmartHttpTransport(NO_LOCAL, URL_A, fetch, undefined, 2, cache).advertiseRefs();
		expect(counts.infoRefs).toBe(1);
		expect(counts.lsRefs).toBe(1);

		const t = new SmartHttpTransport(NO_LOCAL, URL_A, fetch, undefined, 2, cache);
		t.seedRefs([{ name: "refs/heads/main", hash: HASH_A }]);
		await t.advertiseRefs();
		expect(counts.infoRefs).toBe(1); // cap GET skipped (cache)
		expect(counts.lsRefs).toBe(1); // ls-refs skipped (seed)
	});

	test("a fresh-from-wire failure is not retried (no false self-correction)", async () => {
		// ls-refs always 400s here, regardless of discovery. Since discovery ran
		// from the wire (no cache warm-up), this is a real error: it must
		// propagate without an evict/re-discover dance.
		let infoRefs = 0;
		const fetch: FetchFunction = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			const method = (
				init?.method ?? (input instanceof Request ? input.method : "GET")
			).toUpperCase();
			if (url.includes("/info/refs")) {
				infoRefs++;
				return v2AdvertResponse();
			}
			if (url.includes("git-upload-pack") && method === "POST") {
				return new Response("nope", { status: 400 });
			}
			throw new Error(`unexpected request: ${method} ${url}`);
		};
		const cache = createMemoryDiscoveryCache();
		const t = new SmartHttpTransport(NO_LOCAL, URL_A, fetch, undefined, 2, cache);
		await expect(t.advertiseRefs()).rejects.toThrow("HTTP 400");
		expect(infoRefs).toBe(1); // discovered once, never retried
	});
});
