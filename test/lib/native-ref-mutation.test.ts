import { describe, expect, test } from "bun:test";
import {
	createNativeRefMutation,
	nativeRefPaths,
	NativeRefLockContentionError,
	recoverNativeRefLock,
} from "../../src/lib/refs/native-mutation.ts";
import { CrashableDurableFileSystem } from "../fs/fault/crashable-durable-fs.ts";
import { replayCrashCuts } from "../fs/fault/crash-harness.ts";

const GIT_DIR = "/worktree/git";
const COMMON_DIR = "/repo.git";
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const DIRECT_A = { type: "direct" as const, hash: HASH_A };
const DIRECT_B = { type: "direct" as const, hash: HASH_B };
const SYMBOLIC_MAIN = { type: "symbolic" as const, target: "refs/heads/main" };

async function splitFs(): Promise<CrashableDurableFileSystem> {
	const fs = new CrashableDurableFileSystem();
	await fs.mkdir(GIT_DIR, { recursive: true });
	await fs.mkdir(COMMON_DIR, { recursive: true });
	fs.checkpoint();
	return fs;
}

describe("native ref mutation paths", () => {
	test("routes shared and per-worktree locks to canonical directories", () => {
		expect(nativeRefPaths({ gitDir: GIT_DIR, commonDir: COMMON_DIR }, "refs/heads/main")).toEqual({
			name: "refs/heads/main",
			refPath: `${COMMON_DIR}/refs/heads/main`,
			lockPath: `${COMMON_DIR}/refs/heads/main.lock`,
			packedRefsPath: `${COMMON_DIR}/packed-refs`,
			packedLockPath: `${COMMON_DIR}/packed-refs.lock`,
			isPerWorktree: false,
		});
		expect(nativeRefPaths({ gitDir: GIT_DIR, commonDir: COMMON_DIR }, "HEAD").lockPath).toBe(
			`${GIT_DIR}/HEAD.lock`,
		);
		expect(
			nativeRefPaths({ gitDir: GIT_DIR, commonDir: COMMON_DIR }, "refs/bisect/bad").lockPath,
		).toBe(`${GIT_DIR}/refs/bisect/bad.lock`);
	});

	test("rejects unsafe and unsupported names before path derivation", () => {
		const layout = { gitDir: GIT_DIR, commonDir: COMMON_DIR };
		expect(() => nativeRefPaths(layout, "refs/heads/main.lock")).toThrow("invalid native ref name");
		expect(() => nativeRefPaths(layout, "../HEAD")).toThrow("invalid native ref name");
		expect(() => nativeRefPaths(layout, "head")).toThrow("invalid native ref name");
	});
});

describe("native ref mutation protocol", () => {
	test("publishes direct and symbolic refs through canonical locks", async () => {
		const fs = await splitFs();
		const refs = createNativeRefMutation(fs, { gitDir: GIT_DIR, commonDir: COMMON_DIR });

		await refs.putRef("refs/heads/main", DIRECT_A);
		await refs.putRef("HEAD", SYMBOLIC_MAIN);

		expect(await fs.readFile(`${COMMON_DIR}/refs/heads/main`)).toBe(`${HASH_A}\n`);
		expect(await fs.readFile(`${GIT_DIR}/HEAD`)).toBe("ref: refs/heads/main\n");
		expect(await fs.exists(`${COMMON_DIR}/refs/heads/main.lock`)).toBe(false);
		expect(await fs.exists(`${GIT_DIR}/HEAD.lock`)).toBe(false);
		expect((await fs.readdir(`${COMMON_DIR}/refs/heads`)).sort()).toEqual(["main"]);

		const events = fs.events;
		const linkIndex = events.findIndex(
			(event) =>
				event.operation === "link" && event.destination === `${COMMON_DIR}/refs/heads/main.lock`,
		);
		const lockWriteIndex = events.findIndex(
			(event) =>
				event.operation === "writeFile" && event.path === `${COMMON_DIR}/refs/heads/main.lock`,
		);
		const renameIndex = events.findIndex(
			(event) =>
				event.operation === "rename" &&
				event.path === `${COMMON_DIR}/refs/heads/main.lock` &&
				event.destination === `${COMMON_DIR}/refs/heads/main`,
		);
		expect(linkIndex).toBeGreaterThanOrEqual(0);
		expect(lockWriteIndex).toBeGreaterThan(linkIndex);
		expect(renameIndex).toBeGreaterThan(lockWriteIndex);
	});

	test("compares the exact raw value after locking", async () => {
		const fs = await splitFs();
		await fs.writeFile(
			`${COMMON_DIR}/packed-refs`,
			`${HASH_A} refs/heads/main\n${HASH_C} refs/heads/other\n`,
		);
		const refs = createNativeRefMutation(fs, { gitDir: GIT_DIR, commonDir: COMMON_DIR });

		expect(await refs.compareAndSwapRef("refs/heads/main", DIRECT_A, DIRECT_B)).toBe(true);
		expect(await fs.readFile(`${COMMON_DIR}/refs/heads/main`)).toBe(`${HASH_B}\n`);
		expect(await refs.compareAndSwapRef("refs/heads/main", DIRECT_A, DIRECT_A)).toBe(false);

		await refs.putRef("refs/heads/main", SYMBOLIC_MAIN);
		expect(await refs.compareAndSwapRef("refs/heads/main", DIRECT_B, DIRECT_A)).toBe(false);
		expect(await refs.compareAndSwapRef("refs/heads/main", SYMBOLIC_MAIN, DIRECT_A)).toBe(true);
	});

	test("deletes packed and loose representations while preserving unrelated entries", async () => {
		const fs = await splitFs();
		await fs.mkdir(`${COMMON_DIR}/refs/heads`, { recursive: true });
		await fs.writeFile(`${COMMON_DIR}/refs/heads/main`, `${HASH_B}\n`);
		await fs.writeFile(
			`${COMMON_DIR}/packed-refs`,
			[
				"# pack-refs with: peeled",
				`${HASH_A} refs/heads/main`,
				`^${HASH_C}`,
				`${HASH_C} refs/heads/other`,
				"",
			].join("\n"),
		);
		const refs = createNativeRefMutation(fs, { gitDir: GIT_DIR, commonDir: COMMON_DIR });
		fs.checkpoint();

		await refs.removeRef("refs/heads/main");

		expect(await fs.exists(`${COMMON_DIR}/refs/heads/main`)).toBe(false);
		expect(await fs.readFile(`${COMMON_DIR}/packed-refs`)).toBe(
			`# pack-refs with: peeled\n${HASH_C} refs/heads/other\n`,
		);
		expect(await fs.exists(`${COMMON_DIR}/packed-refs.lock`)).toBe(false);
		expect(await fs.exists(`${COMMON_DIR}/refs/heads/main.lock`)).toBe(false);

		const namedLink = fs.events.findIndex(
			(event) =>
				event.operation === "link" && event.destination === `${COMMON_DIR}/refs/heads/main.lock`,
		);
		const packedLink = fs.events.findIndex(
			(event) =>
				event.operation === "link" && event.destination === `${COMMON_DIR}/packed-refs.lock`,
		);
		const packedPublish = fs.events.findIndex(
			(event) => event.operation === "rename" && event.destination === `${COMMON_DIR}/packed-refs`,
		);
		const looseRemoval = fs.events.findIndex(
			(event) => event.operation === "rm" && event.path === `${COMMON_DIR}/refs/heads/main`,
		);
		const packedUnlock = fs.events.findIndex(
			(event) => event.operation === "rm" && event.path === `${COMMON_DIR}/packed-refs.lock`,
		);
		const namedUnlock = fs.events.findIndex(
			(event) => event.operation === "rm" && event.path === `${COMMON_DIR}/refs/heads/main.lock`,
		);
		expect(namedLink).toBeGreaterThanOrEqual(0);
		expect(packedLink).toBeGreaterThan(namedLink);
		expect(packedPublish).toBeGreaterThan(packedLink);
		expect(looseRemoval).toBeGreaterThan(packedPublish);
		expect(packedUnlock).toBeGreaterThan(looseRemoval);
		expect(namedUnlock).toBeGreaterThan(packedUnlock);
	});

	test("publishes packed refs before conditionally pruning loose refs", async () => {
		const fs = await splitFs();
		const refPath = `${COMMON_DIR}/refs/heads/main`;
		const packedPath = `${COMMON_DIR}/packed-refs`;
		await fs.mkdir(`${COMMON_DIR}/refs/heads`, { recursive: true });
		await fs.writeFile(refPath, `${HASH_A}\n`);
		const refs = createNativeRefMutation(fs, { gitDir: GIT_DIR, commonDir: COMMON_DIR });
		fs.checkpoint();

		await refs.packRefs(async () => ({
			content: `${HASH_A} refs/heads/main\n`,
			pruneCandidates: [{ name: "refs/heads/main", ref: DIRECT_A }],
		}));

		expect(await fs.readFile(packedPath)).toBe(`${HASH_A} refs/heads/main\n`);
		expect(await fs.exists(refPath)).toBe(false);
		const packedLink = fs.events.findIndex(
			(event) => event.operation === "link" && event.destination === `${packedPath}.lock`,
		);
		const packedPublish = fs.events.findIndex(
			(event) => event.operation === "rename" && event.destination === packedPath,
		);
		const namedLink = fs.events.findIndex(
			(event) => event.operation === "link" && event.destination === `${refPath}.lock`,
		);
		expect(packedLink).toBeGreaterThanOrEqual(0);
		expect(packedPublish).toBeGreaterThan(packedLink);
		expect(namedLink).toBeGreaterThan(packedPublish);
	});

	test("retains a loose ref changed after the packed snapshot", async () => {
		const fs = await splitFs();
		const refPath = `${COMMON_DIR}/refs/heads/main`;
		await fs.mkdir(`${COMMON_DIR}/refs/heads`, { recursive: true });
		await fs.writeFile(refPath, `${HASH_A}\n`);
		const refs = createNativeRefMutation(fs, { gitDir: GIT_DIR, commonDir: COMMON_DIR });
		fs.checkpoint();

		await refs.packRefs(async () => {
			await fs.writeFile(refPath, `${HASH_B}\n`);
			return {
				content: `${HASH_A} refs/heads/main\n`,
				pruneCandidates: [{ name: "refs/heads/main", ref: DIRECT_A }],
			};
		});

		expect(await fs.readFile(`${COMMON_DIR}/packed-refs`)).toBe(`${HASH_A} refs/heads/main\n`);
		expect(await fs.readFile(refPath)).toBe(`${HASH_B}\n`);
	});

	test("per-worktree deletion does not depend on packed-refs locking", async () => {
		const fs = await splitFs();
		await fs.writeFile(`${GIT_DIR}/ORIG_HEAD`, `${HASH_A}\n`);
		await fs.writeFile(`${COMMON_DIR}/packed-refs.lock`, "");
		const refs = createNativeRefMutation(
			fs,
			{ gitDir: GIT_DIR, commonDir: COMMON_DIR },
			{ lockTimeoutMs: 0 },
		);

		await refs.removeRef("ORIG_HEAD");

		expect(await fs.exists(`${GIT_DIR}/ORIG_HEAD`)).toBe(false);
		expect(await fs.exists(`${COMMON_DIR}/packed-refs.lock`)).toBe(true);
	});

	test("holds an empty named lock while acquiring the packed-refs lock for deletion", async () => {
		const fs = await splitFs();
		await fs.mkdir(`${COMMON_DIR}/refs/heads`, { recursive: true });
		await fs.writeFile(`${COMMON_DIR}/refs/heads/main`, `${HASH_A}\n`);
		const originalLink = fs.link.bind(fs);
		let reachedPackedLock!: () => void;
		const packedLockReached = new Promise<void>((resolve) => {
			reachedPackedLock = resolve;
		});
		let releasePackedLock!: () => void;
		const packedLockMayProceed = new Promise<void>((resolve) => {
			releasePackedLock = resolve;
		});
		fs.link = async (existingPath, newPath) => {
			if (newPath === `${COMMON_DIR}/packed-refs.lock`) {
				expect(await fs.readFile(`${COMMON_DIR}/refs/heads/main.lock`)).toBe("");
				reachedPackedLock();
				await packedLockMayProceed;
			}
			await originalLink(existingPath, newPath);
		};
		const refs = createNativeRefMutation(fs, { gitDir: GIT_DIR, commonDir: COMMON_DIR });

		const deletion = refs.removeRef("refs/heads/main");
		await packedLockReached;
		expect(await fs.readFile(`${COMMON_DIR}/refs/heads/main`)).toBe(`${HASH_A}\n`);
		releasePackedLock();
		await deletion;
	});

	test("packed-refs lock contention preserves the ref and cleans the named lock", async () => {
		const fs = await splitFs();
		await fs.mkdir(`${COMMON_DIR}/refs/heads`, { recursive: true });
		await fs.writeFile(`${COMMON_DIR}/refs/heads/main`, `${HASH_A}\n`);
		await fs.writeFile(`${COMMON_DIR}/packed-refs`, `${HASH_A} refs/heads/main\n`);
		await fs.writeFile(`${COMMON_DIR}/packed-refs.lock`, "native git owns this");
		const refs = createNativeRefMutation(
			fs,
			{ gitDir: GIT_DIR, commonDir: COMMON_DIR },
			{ lockTimeoutMs: 0 },
		);

		expect(refs.removeRef("refs/heads/main")).rejects.toBeInstanceOf(NativeRefLockContentionError);
		expect(await fs.readFile(`${COMMON_DIR}/refs/heads/main`)).toBe(`${HASH_A}\n`);
		expect(await fs.readFile(`${COMMON_DIR}/packed-refs`)).toBe(`${HASH_A} refs/heads/main\n`);
		expect(await fs.readFile(`${COMMON_DIR}/packed-refs.lock`)).toBe("native git owns this");
		expect((await fs.readdir(`${COMMON_DIR}/refs/heads`)).sort()).toEqual(["main"]);
	});

	test("times out on an existing lock without breaking it or leaking claimants", async () => {
		const fs = await splitFs();
		await fs.mkdir(`${COMMON_DIR}/refs/heads`, { recursive: true });
		await fs.writeFile(`${COMMON_DIR}/refs/heads/main.lock`, "native git owns this");
		const refs = createNativeRefMutation(
			fs,
			{ gitDir: GIT_DIR, commonDir: COMMON_DIR },
			{ lockTimeoutMs: 0 },
		);

		const error = await refs.putRef("refs/heads/main", DIRECT_A).catch((caught) => caught);
		expect(error).toBeInstanceOf(NativeRefLockContentionError);
		expect(await fs.readFile(`${COMMON_DIR}/refs/heads/main.lock`)).toBe("native git owns this");
		expect((await fs.readdir(`${COMMON_DIR}/refs/heads`)).sort()).toEqual(["main.lock"]);
	});

	test("ordinary publication errors preserve the old ref and clean lock artifacts", async () => {
		const fs = await splitFs();
		const refs = createNativeRefMutation(fs, { gitDir: GIT_DIR, commonDir: COMMON_DIR });
		await refs.putRef("refs/heads/main", DIRECT_A);
		const originalWriteFile = fs.writeFile.bind(fs);
		fs.writeFile = async (path, content) => {
			if (path === `${COMMON_DIR}/refs/heads/main.lock`) {
				throw new Error("injected lockfile write failure");
			}
			await originalWriteFile(path, content);
		};

		expect(refs.putRef("refs/heads/main", DIRECT_B)).rejects.toThrow(
			"injected lockfile write failure",
		);
		expect(await fs.readFile(`${COMMON_DIR}/refs/heads/main`)).toBe(`${HASH_A}\n`);
		expect((await fs.readdir(`${COMMON_DIR}/refs/heads`)).sort()).toEqual(["main"]);
	});

	test("queues the same canonical path while allowing another ref to proceed", async () => {
		const fs = await splitFs();
		const originalLink = fs.link.bind(fs);
		let releaseFirst!: () => void;
		const firstMayLink = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let blockFirstMain = true;
		fs.link = async (existingPath, newPath) => {
			if (blockFirstMain && newPath === `${COMMON_DIR}/refs/heads/main.lock`) {
				blockFirstMain = false;
				await firstMayLink;
			}
			await originalLink(existingPath, newPath);
		};
		const refs = createNativeRefMutation(fs, { gitDir: GIT_DIR, commonDir: COMMON_DIR });

		const first = refs.putRef("refs/heads/main", DIRECT_A);
		let secondFinished = false;
		const second = refs.putRef("refs/heads/main", DIRECT_B).then(() => {
			secondFinished = true;
		});
		await refs.putRef("refs/heads/other", { type: "direct", hash: HASH_C });

		expect(secondFinished).toBe(false);
		expect(await fs.readFile(`${COMMON_DIR}/refs/heads/other`)).toBe(`${HASH_C}\n`);
		releaseFirst();
		await Promise.all([first, second]);
		expect(await fs.readFile(`${COMMON_DIR}/refs/heads/main`)).toBe(`${HASH_B}\n`);
	});

	test("targeted recovery removes only requested lock artifacts", async () => {
		const fs = await splitFs();
		await fs.mkdir(`${COMMON_DIR}/refs/heads`, { recursive: true });
		await fs.writeFile(`${COMMON_DIR}/refs/heads/main.lock`, "");
		await fs.writeFile(`${COMMON_DIR}/refs/heads/main.lock.tmp-stale`, "");
		await fs.writeFile(`${COMMON_DIR}/refs/heads/other.lock`, "");
		await fs.writeFile(`${COMMON_DIR}/packed-refs.lock`, "");
		await fs.writeFile(`${COMMON_DIR}/packed-refs.lock.tmp-stale`, "");

		await recoverNativeRefLock(fs, { gitDir: GIT_DIR, commonDir: COMMON_DIR }, "refs/heads/main", {
			includePackedRefsLock: true,
		});

		expect(await fs.exists(`${COMMON_DIR}/refs/heads/main.lock`)).toBe(false);
		expect(await fs.exists(`${COMMON_DIR}/refs/heads/main.lock.tmp-stale`)).toBe(false);
		expect(await fs.exists(`${COMMON_DIR}/packed-refs.lock`)).toBe(false);
		expect(await fs.exists(`${COMMON_DIR}/packed-refs.lock.tmp-stale`)).toBe(false);
		expect(await fs.exists(`${COMMON_DIR}/refs/heads/other.lock`)).toBe(true);
	});

	test("crash cuts around publication expose only the old or complete new value", async () => {
		await replayCrashCuts({
			async setup(fs) {
				await fs.mkdir(`${COMMON_DIR}/refs/heads`, { recursive: true });
				await fs.mkdir(GIT_DIR, { recursive: true });
				await fs.writeFile(`${COMMON_DIR}/refs/heads/main`, `${HASH_A}\n`);
			},
			async operation(fs) {
				const refs = createNativeRefMutation(fs, {
					gitDir: GIT_DIR,
					commonDir: COMMON_DIR,
				});
				await refs.putRef("refs/heads/main", DIRECT_B);
			},
			async verifyCut({ fs }) {
				const value = await fs.readFile(`${COMMON_DIR}/refs/heads/main`);
				expect([`${HASH_A}\n`, `${HASH_B}\n`]).toContain(value);
			},
			async verifySuccess(fs) {
				expect(await fs.readFile(`${COMMON_DIR}/refs/heads/main`)).toBe(`${HASH_B}\n`);
				expect(await fs.exists(`${COMMON_DIR}/refs/heads/main.lock`)).toBe(false);
				expect((await fs.readdir(`${COMMON_DIR}/refs/heads`)).sort()).toEqual(["main"]);
			},
		});
	});

	test("crash cuts around packed publication expose only complete packed files", async () => {
		const oldPacked = `${HASH_C} refs/heads/other\n`;
		const newPacked = `${HASH_A} refs/heads/main\n${HASH_C} refs/heads/other\n`;
		await replayCrashCuts({
			async setup(fs) {
				await fs.mkdir(`${COMMON_DIR}/refs/heads`, { recursive: true });
				await fs.mkdir(GIT_DIR, { recursive: true });
				await fs.writeFile(`${COMMON_DIR}/refs/heads/main`, `${HASH_A}\n`);
				await fs.writeFile(`${COMMON_DIR}/packed-refs`, oldPacked);
			},
			async operation(fs) {
				const refs = createNativeRefMutation(fs, {
					gitDir: GIT_DIR,
					commonDir: COMMON_DIR,
				});
				await refs.packRefs(async () => ({
					content: newPacked,
					pruneCandidates: [{ name: "refs/heads/main", ref: DIRECT_A }],
				}));
			},
			async verifyCut({ fs }) {
				expect([oldPacked, newPacked]).toContain(await fs.readFile(`${COMMON_DIR}/packed-refs`));
			},
			async verifySuccess(fs) {
				expect(await fs.readFile(`${COMMON_DIR}/packed-refs`)).toBe(newPacked);
				expect(await fs.exists(`${COMMON_DIR}/refs/heads/main`)).toBe(false);
				expect(await fs.exists(`${COMMON_DIR}/packed-refs.lock`)).toBe(false);
			},
		});
	});
});
