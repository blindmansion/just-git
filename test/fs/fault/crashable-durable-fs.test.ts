import { describe, expect, test } from "bun:test";
import { CrashableDurableFileSystem, SimulatedCrashError } from "./crashable-durable-fs.ts";

describe("CrashableDurableFileSystem", () => {
	test("file contents remain volatile until file fsync", async () => {
		const fs = await baseline({ "/value": "old" });
		await fs.writeFile("/value", "new");
		expect(await fs.readFile("/value")).toBe("new");
		expect(await fs.reboot().readFile("/value")).toBe("old");

		await fs.fsync("/value");
		expect(await fs.reboot().readFile("/value")).toBe("new");
	});

	test("directory entries remain volatile until their parent is fsynced", async () => {
		const fs = new CrashableDurableFileSystem();
		await fs.writeFile("/value", "content");
		await fs.fsync("/value");
		expect(await fs.reboot().exists("/value")).toBe(false);

		await fs.fsync("/");
		expect(await fs.reboot().readFile("/value")).toBe("content");
	});

	test("directory fsync does not persist unflushed file contents", async () => {
		const fs = new CrashableDurableFileSystem();
		await fs.writeFile("/value", "volatile");
		await fs.fsync("/");

		expect(await fs.reboot().readFile("/value")).toBe("");
	});

	test("rename-over-destination publishes one complete inode atomically", async () => {
		const fs = await baseline({ "/source": "new", "/destination": "old" });
		await fs.rename("/source", "/destination");

		const beforeDirectorySync = fs.reboot();
		expect(await beforeDirectorySync.readFile("/source")).toBe("new");
		expect(await beforeDirectorySync.readFile("/destination")).toBe("old");

		await fs.fsync("/");
		const afterDirectorySync = fs.reboot();
		expect(await afterDirectorySync.exists("/source")).toBe(false);
		expect(await afterDirectorySync.readFile("/destination")).toBe("new");
	});

	test("persists each side of a cross-directory rename independently", async () => {
		const fs = new CrashableDurableFileSystem();
		await fs.mkdir("/from");
		await fs.mkdir("/to");
		await fs.writeFile("/from/value", "content");
		await fs.checkpoint();

		await fs.rename("/from/value", "/to/value");
		await fs.fsync("/to");
		let rebooted = fs.reboot();
		expect(await rebooted.readFile("/from/value")).toBe("content");
		expect(await rebooted.readFile("/to/value")).toBe("content");

		await fs.fsync("/from");
		rebooted = fs.reboot();
		expect(await rebooted.exists("/from/value")).toBe(false);
		expect(await rebooted.readFile("/to/value")).toBe("content");
	});

	test("hard links share one inode", async () => {
		const fs = await baseline({ "/source": "one" });
		await fs.link("/source", "/link");
		await fs.fsync("/");
		await fs.writeFile("/link", "two");
		await fs.fsync("/source");

		const rebooted = fs.reboot();
		expect(await rebooted.readFile("/source")).toBe("two");
		expect(await rebooted.readFile("/link")).toBe("two");
	});

	test("link rejects an existing destination with EEXIST", async () => {
		const fs = await baseline({ "/source": "one", "/destination": "two" });
		expect(fs.link("/source", "/destination")).rejects.toMatchObject({ code: "EEXIST" });
		expect(await fs.readFile("/destination")).toBe("two");
	});

	test("removal becomes durable only after the parent is fsynced", async () => {
		const fs = await baseline({ "/value": "content" });
		await fs.rm("/value");
		expect(await fs.reboot().readFile("/value")).toBe("content");

		await fs.fsync("/");
		expect(await fs.reboot().exists("/value")).toBe(false);
	});

	test("reboot discards all volatile namespace and content changes", async () => {
		const fs = await baseline({ "/old": "old" });
		await fs.writeFile("/old", "changed");
		await fs.writeFile("/new", "new");
		await fs.rm("/old");

		const rebooted = fs.reboot();
		expect(await rebooted.readFile("/old")).toBe("old");
		expect(await rebooted.exists("/new")).toBe(false);
	});

	test("a simulated crash freezes finally cleanup", async () => {
		const fs = new CrashableDurableFileSystem();
		fs.checkpoint();
		fs.armCrashAfter(2);

		await expect(
			(async () => {
				try {
					await fs.writeFile("/claimant", "content");
					await fs.fsync("/claimant");
				} finally {
					await fs.rm("/claimant", { force: true });
					await fs.fsync("/");
				}
			})(),
		).rejects.toBeInstanceOf(SimulatedCrashError);

		expect(fs.events.map((event) => event.operation)).toEqual(["writeFile", "fsync"]);
		expect(await fs.reboot().exists("/claimant")).toBe(false);
	});
});

async function baseline(files: Record<string, string>): Promise<CrashableDurableFileSystem> {
	const fs = new CrashableDurableFileSystem();
	for (const [path, content] of Object.entries(files)) await fs.writeFile(path, content);
	fs.checkpoint();
	return fs;
}
