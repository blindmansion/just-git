import { describe, expect, test } from "bun:test";
import type { Ref } from "../../../src/lib/types.ts";
import { FsRefStorage } from "../../../src/store/fs-ref-storage.ts";
import { replayCrashCuts } from "./crash-harness.ts";
import { CrashableDurableFileSystem } from "./crashable-durable-fs.ts";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);

describe("FsRefStorage crash durability", () => {
	for (const scenario of [
		{
			label: "direct ref",
			name: "refs/heads/main",
			old: direct(HASH_A),
			replacement: direct(HASH_B),
		},
		{
			label: "symbolic ref",
			name: "HEAD",
			old: symbolic("refs/heads/main"),
			replacement: symbolic("refs/heads/next"),
		},
	] as const) {
		test(`replacement publishes an old-or-new complete ${scenario.label}`, async () => {
			await replayCrashCuts({
				setup: async (fs) => {
					await setupRepo(fs);
					await refs(fs).putRef(scenario.name, scenario.old);
				},
				operation: (fs) => refs(fs).putRef(scenario.name, scenario.replacement),
				verifyCut: async ({ fs }) => {
					const ref = await refs(fs).getRef(scenario.name);
					expect(ref).not.toBeNull();
					expect([scenario.old, scenario.replacement]).toContainEqual(ref!);
					await assertSafeLockState(fs, scenario.name);
				},
				verifySuccess: async (fs) => {
					expect(await refs(fs).getRef(scenario.name)).toEqual(scenario.replacement);
				},
			});
		});
	}

	for (const scenario of [
		{ label: "direct ref", name: "refs/heads/new", ref: direct(HASH_A) },
		{ label: "symbolic ref", name: "HEAD", ref: symbolic("refs/heads/main") },
	] as const) {
		test(`creation publishes an absent-or-complete ${scenario.label}`, async () => {
			await replayCrashCuts({
				setup: setupRepo,
				operation: (fs) => refs(fs).putRef(scenario.name, scenario.ref),
				verifyCut: async ({ fs }) => {
					expect([null, scenario.ref]).toContainEqual(await refs(fs).getRef(scenario.name));
					await assertSafeLockState(fs, scenario.name);
				},
				verifySuccess: async (fs) => {
					expect(await refs(fs).getRef(scenario.name)).toEqual(scenario.ref);
				},
			});
		});
	}

	for (const scenario of [
		{ label: "loose-only", loose: HASH_A, packed: false },
		{ label: "packed-only", loose: null, packed: true },
		{ label: "loose shadow over packed", loose: HASH_B, packed: true },
	] as const) {
		test(`deletion of a ${scenario.label} ref never reveals stale data`, async () => {
			await replayCrashCuts({
				setup: async (fs) => {
					await setupRepo(fs);
					if (scenario.packed) await fs.writeFile("/repo/packed-refs", packedRefs());
					if (scenario.loose) {
						await refs(fs).putRef("refs/heads/main", direct(scenario.loose));
					}
				},
				operation: (fs) => refs(fs).removeRef("refs/heads/main"),
				verifyCut: async ({ fs }) => {
					const authoritativeHash = scenario.loose ?? HASH_A;
					expect([direct(authoritativeHash), null]).toContainEqual(
						await refs(fs).getRef("refs/heads/main"),
					);
					expect(await refs(fs).getRef("refs/heads/keep")).toEqual(
						scenario.packed ? direct(HASH_C) : null,
					);
					if (scenario.packed && (await fs.exists("/repo/packed-refs"))) {
						assertValidPackedRefs(await fs.readFile("/repo/packed-refs"));
					}
					await assertSafeLockState(fs, "refs/heads/main");
				},
				verifySuccess: async (fs) => {
					expect(await refs(fs).getRef("refs/heads/main")).toBeNull();
					expect(await refs(fs).getRef("refs/heads/keep")).toEqual(
						scenario.packed ? direct(HASH_C) : null,
					);
				},
			});
		});
	}

	test("deletion of the last packed ref leaves the old file or durable absence", async () => {
		const content = `${HASH_A} refs/heads/main\n`;
		await replayCrashCuts({
			setup: async (fs) => {
				await setupRepo(fs);
				await fs.writeFile("/repo/packed-refs", content);
			},
			operation: (fs) => refs(fs).removeRef("refs/heads/main"),
			verifyCut: async ({ fs }) => {
				expect([direct(HASH_A), null]).toContainEqual(await refs(fs).getRef("refs/heads/main"));
				if (await fs.exists("/repo/packed-refs")) {
					expect(await fs.readFile("/repo/packed-refs")).toBe(content);
				}
			},
			verifySuccess: async (fs) => {
				expect(await refs(fs).getRef("refs/heads/main")).toBeNull();
				expect(await fs.exists("/repo/packed-refs")).toBe(false);
			},
		});
	});

	test("packed deletion preserves unrelated refs and peeled lines", async () => {
		await replayCrashCuts({
			setup: async (fs) => {
				await setupRepo(fs);
				await fs.writeFile("/repo/packed-refs", packedRefs());
			},
			operation: (fs) => refs(fs).removeRef("refs/tags/v1"),
			verifyCut: async ({ fs }) => {
				expect([direct(HASH_B), null]).toContainEqual(await refs(fs).getRef("refs/tags/v1"));
				expect(await refs(fs).getRef("refs/heads/main")).toEqual(direct(HASH_A));
				expect(await refs(fs).getRef("refs/heads/keep")).toEqual(direct(HASH_C));
				if (await fs.exists("/repo/packed-refs")) {
					assertValidPackedRefs(await fs.readFile("/repo/packed-refs"));
				}
			},
			verifySuccess: async (fs) => {
				const packed = await fs.readFile("/repo/packed-refs");
				expect(packed).not.toContain("refs/tags/v1");
				expect(packed).not.toContain(`^${HASH_C}`);
				expect(packed).toContain(`${HASH_C} refs/heads/keep`);
			},
		});
	});

	test("CAS replacement commits one old-or-new ref", async () => {
		await replayCrashCuts({
			setup: async (fs) => {
				await setupRepo(fs);
				await refs(fs).putRef("refs/heads/main", direct(HASH_A));
			},
			operation: (fs) =>
				refs(fs).compareAndSwapRef("refs/heads/main", direct(HASH_A), direct(HASH_B)),
			verifyCut: async ({ fs }) => {
				const ref = await refs(fs).getRef("refs/heads/main");
				expect(ref).not.toBeNull();
				expect([direct(HASH_A), direct(HASH_B)]).toContainEqual(ref!);
				await assertSafeLockState(fs, "refs/heads/main");
			},
			verifySuccess: async (fs) => {
				expect(await refs(fs).getRef("refs/heads/main")).toEqual(direct(HASH_B));
			},
		});
	});

	test("CAS removal commits one old-or-absent ref", async () => {
		await replayCrashCuts({
			setup: async (fs) => {
				await setupRepo(fs);
				await refs(fs).putRef("refs/heads/main", direct(HASH_A));
			},
			operation: (fs) => refs(fs).compareAndSwapRef("refs/heads/main", direct(HASH_A), null),
			verifyCut: async ({ fs }) => {
				expect([direct(HASH_A), null]).toContainEqual(await refs(fs).getRef("refs/heads/main"));
				await assertSafeLockState(fs, "refs/heads/main");
			},
			verifySuccess: async (fs) => {
				expect(await refs(fs).getRef("refs/heads/main")).toBeNull();
			},
		});
	});

	test("a mismatched CAS never changes the committed ref", async () => {
		await replayCrashCuts({
			setup: async (fs) => {
				await setupRepo(fs);
				await refs(fs).putRef("refs/heads/main", direct(HASH_A));
			},
			operation: (fs) =>
				refs(fs).compareAndSwapRef("refs/heads/main", direct(HASH_B), direct(HASH_C)),
			verifyCut: async ({ fs }) => {
				expect(await refs(fs).getRef("refs/heads/main")).toEqual(direct(HASH_A));
				await assertSafeLockState(fs, "refs/heads/main");
			},
			verifySuccess: async (fs) => {
				expect(await refs(fs).getRef("refs/heads/main")).toEqual(direct(HASH_A));
			},
		});
	});

	test("ordinary CAS mismatch publishes nothing and releases canonical lock artifacts", async () => {
		const fs = await readyRepo();
		await refs(fs).putRef("refs/heads/main", direct(HASH_A));

		expect(
			await refs(fs).compareAndSwapRef("refs/heads/main", direct(HASH_B), direct(HASH_C)),
		).toBe(false);

		expect(await refs(fs).getRef("refs/heads/main")).toEqual(direct(HASH_A));
		expect(await fs.exists("/repo/refs/heads/main.lock")).toBe(false);
		expect(
			(await fs.readdir("/repo/refs/heads")).filter((name) => name.startsWith("main.lock.tmp-")),
		).toEqual([]);
	});
});

async function setupRepo(fs: CrashableDurableFileSystem): Promise<void> {
	await fs.mkdir("/repo");
	await fs.mkdir("/repo/refs");
}

async function readyRepo(): Promise<CrashableDurableFileSystem> {
	const fs = new CrashableDurableFileSystem();
	await setupRepo(fs);
	fs.checkpoint();
	return fs;
}

function refs(fs: CrashableDurableFileSystem): FsRefStorage {
	return new FsRefStorage(fs, "/repo");
}

function direct(hash: string): Ref {
	return { type: "direct", hash };
}

function symbolic(target: string): Ref {
	return { type: "symbolic", target };
}

function packedRefs(): string {
	return [
		"# pack-refs with: peeled fully-peeled sorted",
		`${HASH_A} refs/heads/main`,
		`${HASH_B} refs/tags/v1`,
		`^${HASH_C}`,
		`${HASH_C} refs/heads/keep`,
		"",
	].join("\n");
}

function assertValidPackedRefs(content: string): void {
	expect([packedRefs(), withoutMain(), withoutTag()]).toContain(content);
}

function withoutMain(): string {
	return [
		"# pack-refs with: peeled fully-peeled sorted",
		`${HASH_B} refs/tags/v1`,
		`^${HASH_C}`,
		`${HASH_C} refs/heads/keep`,
		"",
	].join("\n");
}

function withoutTag(): string {
	return [
		"# pack-refs with: peeled fully-peeled sorted",
		`${HASH_A} refs/heads/main`,
		`${HASH_C} refs/heads/keep`,
		"",
	].join("\n");
}

async function assertSafeLockState(fs: CrashableDurableFileSystem, refName: string): Promise<void> {
	expect(await fs.exists("/repo/.just-git-ref.lock")).toBe(false);

	const refPath = `/repo/${refName}`;
	const slash = refPath.lastIndexOf("/");
	const parent = refPath.slice(0, slash);
	const lockName = `${refPath.slice(slash + 1)}.lock`;
	if (await fs.exists(parent)) {
		for (const entry of await fs.readdir(parent)) {
			if (entry !== lockName && !entry.startsWith(`${lockName}.tmp-`)) continue;
			expect(await fs.readFile(`${parent}/${entry}`)).toMatch(
				/^(?:|[0-9a-f]{40}\n|ref: refs\/[^\n]+\n)$/,
			);
		}
	}

	for (const entry of await fs.readdir("/repo")) {
		if (entry !== "packed-refs.lock" && !entry.startsWith("packed-refs.lock.tmp-")) continue;
		expect(await fs.readFile(`/repo/${entry}`)).toBe("");
	}
}
