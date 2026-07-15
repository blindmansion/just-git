import { describe, expect, test } from "bun:test";
import {
	createFileDurable,
	ensureDirectoryDurable,
	installPackPair,
	removeFileDurable,
	replaceFileDurable,
	withFileLock,
} from "../../../src/fs/durable-io.ts";
import { replayCrashCuts } from "./crash-harness.ts";
import { CrashableDurableFileSystem } from "./crashable-durable-fs.ts";
import {
	assertAbsentOrComplete,
	assertOldOrNewFile,
	expectNoTemporaryEntries,
	readFileIfPresent,
} from "./invariants.ts";

describe("durable I/O crash protocols", () => {
	test("ensureDirectoryDurable leaves a valid prefix and retry converges", async () => {
		const trace = await replayCrashCuts({
			setup: async () => {},
			operation: (fs) => ensureDirectoryDurable(fs, "/one/two/three"),
			verifyCut: async ({ fs }) => {
				const present = await Promise.all(
					["/one", "/one/two", "/one/two/three"].map((path) => fs.exists(path)),
				);
				expect(present).toEqual([...present].sort().reverse());
			},
			verifySuccess: async (fs) => {
				expect(await fs.stat("/one/two/three")).toMatchObject({ isDirectory: true });
			},
			retry: async (fs) => {
				await ensureDirectoryDurable(fs, "/one/two/three");
				expect(await fs.stat("/one/two/three")).toMatchObject({ isDirectory: true });
			},
		});

		expect(trace.map((event) => event.operation)).toEqual([
			"mkdir",
			"fsync",
			"mkdir",
			"fsync",
			"mkdir",
			"fsync",
		]);
	});

	test("ensureDirectoryDurable accepts only an EEXIST race with a directory", async () => {
		const directoryRace = new HiddenOnceExistsFileSystem("/target");
		await directoryRace.mkdir("/target");
		directoryRace.hideNextExists();
		await expect(ensureDirectoryDurable(directoryRace, "/target")).resolves.toBeUndefined();

		const fileRace = new HiddenOnceExistsFileSystem("/target");
		await fileRace.writeFile("/target", "not a directory");
		fileRace.hideNextExists();
		await expect(ensureDirectoryDurable(fileRace, "/target")).rejects.toMatchObject({
			code: "EEXIST",
		});
	});

	for (const [label, oldContent] of [
		["creation", undefined],
		["replacement", "old"],
	] as const) {
		test(`replaceFileDurable ${label} is old-or-new and retryable at every cut`, async () => {
			await replayCrashCuts({
				setup: async (fs) => {
					if (oldContent !== undefined) await fs.writeFile("/value", oldContent);
				},
				operation: (fs) => replaceFileDurable(fs, "/value", "new"),
				verifyCut: ({ fs }) => assertOldOrNewFile(fs, "/value", oldContent, "new"),
				verifySuccess: async (fs) => {
					expect(await fs.readFile("/value")).toBe("new");
				},
				retry: async (fs) => {
					await replaceFileDurable(fs, "/value", "new");
					expect(await fs.reboot().readFile("/value")).toBe("new");
				},
			});
		});
	}

	test("createFileDurable publishes complete content and retry converges", async () => {
		await replayCrashCuts({
			setup: async () => {},
			operation: (fs) => createFileDurable(fs, "/objects/value", "content"),
			verifyCut: ({ fs }) => assertAbsentOrComplete(fs, "/objects/value", "content"),
			verifySuccess: async (fs) => {
				expect(await fs.readFile("/objects/value")).toBe("content");
			},
			retry: async (fs) => {
				await createFileDurable(fs, "/objects/value", "content");
				expect(await fs.reboot().readFile("/objects/value")).toBe("content");
			},
		});
	});

	test("createFileDurable never replaces an existing destination", async () => {
		await replayCrashCuts({
			setup: async (fs) => {
				await fs.writeFile("/value", "old");
			},
			operation: async (fs) => {
				expect(await createFileDurable(fs, "/value", "new")).toBe(false);
			},
			verifyCut: async ({ fs }) => {
				expect(await fs.readFile("/value")).toBe("old");
			},
			verifySuccess: async (fs) => {
				expect(await fs.readFile("/value")).toBe("old");
			},
		});
	});

	test("exactly one concurrent immutable-file claimant wins", async () => {
		const fs = new CrashableDurableFileSystem();
		const outcomes = await Promise.all([
			createFileDurable(fs, "/value", "one"),
			createFileDurable(fs, "/value", "two"),
		]);

		expect(outcomes.sort()).toEqual([false, true]);
		expect(["one", "two"]).toContain(await fs.readFile("/value"));
	});

	test("removeFileDurable is old-or-absent and retryable", async () => {
		await replayCrashCuts({
			setup: async (fs) => {
				await fs.writeFile("/value", "old");
			},
			operation: (fs) => removeFileDurable(fs, "/value"),
			verifyCut: async ({ fs }) => {
				expect(["old", undefined]).toContain(await readFileIfPresent(fs, "/value"));
			},
			verifySuccess: async (fs) => {
				expect(await fs.exists("/value")).toBe(false);
			},
			retry: async (fs) => {
				await removeFileDurable(fs, "/value");
				expect(await fs.reboot().exists("/value")).toBe(false);
			},
		});
	});

	test("withFileLock runs callbacks only after durable acquisition", async () => {
		interface Context {
			callbackRan: boolean;
		}
		await replayCrashCuts<Context>({
			setup: async () => {},
			createContext: () => ({ callbackRan: false }),
			operation: (fs, context) =>
				withFileLock(fs, "/repo/ref.lock", async () => {
					context.callbackRan = true;
				}),
			verifyCut: async ({ cut, fs, context }) => {
				const lockExists = await fs.exists("/repo/ref.lock");
				if (cut <= 5) {
					expect(context.callbackRan).toBe(false);
					expect(lockExists).toBe(false);
				} else if (cut <= 7) {
					expect(lockExists).toBe(true);
				} else {
					expect(context.callbackRan).toBe(true);
					expect(lockExists).toBe(false);
				}
				if (!context.callbackRan && lockExists) {
					// The acquisition fsync itself can crash after making the lock durable,
					// before control returns to the helper to invoke the callback.
					expect(await fs.readFile("/repo/ref.lock")).toBe("");
				}
				if (await fs.exists("/repo")) {
					for (const entry of await fs.readdir("/repo")) {
						if (entry !== "ref.lock") expect(entry.startsWith("ref.lock.tmp-")).toBe(true);
					}
				}
			},
			verifySuccess: async (fs, context) => {
				expect(context.callbackRan).toBe(true);
				expect(await fs.exists("/repo/ref.lock")).toBe(false);
			},
		});
	});

	test("withFileLock releases the lock after ordinary callback rejection", async () => {
		const fs = new CrashableDurableFileSystem();
		await expect(
			withFileLock(fs, "/repo/ref.lock", async () => {
				throw new Error("callback failed");
			}),
		).rejects.toThrow("callback failed");
		expect(await fs.exists("/repo/ref.lock")).toBe(false);
		expectNoTemporaryEntries(fs, "/repo");
	});

	test("installPackPair never durably exposes an index before its pack", async () => {
		await replayCrashCuts({
			setup: async () => {},
			operation: (fs) =>
				installPackPair(
					fs,
					"/objects/pack/a.pack",
					new Uint8Array([1, 2]),
					"/objects/pack/a.idx",
					new Uint8Array([3, 4]),
				),
			verifyCut: async ({ fs }) => {
				const pack = await readFileIfPresent(fs, "/objects/pack/a.pack");
				const index = await readFileIfPresent(fs, "/objects/pack/a.idx");
				if (index !== undefined) expect(pack).toBe("\u0001\u0002");
				expect([undefined, "\u0001\u0002"]).toContain(pack);
				expect([undefined, "\u0003\u0004"]).toContain(index);
			},
			verifySuccess: async (fs) => {
				expect(await fs.readFileBuffer("/objects/pack/a.pack")).toEqual(new Uint8Array([1, 2]));
				expect(await fs.readFileBuffer("/objects/pack/a.idx")).toEqual(new Uint8Array([3, 4]));
			},
		});
	});

	test("installPackPair rejects a corrupt existing pack before publishing the index", async () => {
		const fs = new CrashableDurableFileSystem();
		await fs.mkdir("/pack");
		await fs.writeFile("/pack/a.pack", new Uint8Array([9]));
		fs.checkpoint();

		await expect(
			installPackPair(fs, "/pack/a.pack", new Uint8Array([1]), "/pack/a.idx", new Uint8Array([2])),
		).rejects.toThrow("immutable file content mismatch");
		expect(await fs.exists("/pack/a.idx")).toBe(false);
	});
});

class HiddenOnceExistsFileSystem extends CrashableDurableFileSystem {
	private hidden = false;

	constructor(private readonly hiddenPath: string) {
		super();
	}

	hideNextExists(): void {
		this.hidden = true;
	}

	override async exists(path: string): Promise<boolean> {
		if (this.hidden && path === this.hiddenPath) {
			this.hidden = false;
			return false;
		}
		return super.exists(path);
	}
}
