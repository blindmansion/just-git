import { describe, expect, test } from "bun:test";
import { MemoryFileSystem } from "../../src";
import { writeObject } from "../../src/lib/object-db.ts";
import { PackedObjectStore } from "../../src/lib/object-store.ts";
import { FileSystemRefStore } from "../../src/lib/refs.ts";
import type { GitContext } from "../../src/lib/types.ts";
import { checkoutEntry } from "../../src/lib/worktree.ts";

const GIT_DIR = "/wt/.git";

async function context(fs: MemoryFileSystem): Promise<GitContext> {
	await fs.mkdir(GIT_DIR, { recursive: true });
	return {
		fs,
		gitDir: GIT_DIR,
		commonDir: GIT_DIR,
		workTree: "/wt",
		objectStore: new PackedObjectStore(fs, GIT_DIR),
		refStore: new FileSystemRefStore(fs, GIT_DIR, GIT_DIR),
	};
}

describe("checkoutEntry executable bit", () => {
	test("applies 100755 and clears it for 100644 over an executable file", async () => {
		const fs = new MemoryFileSystem();
		const ctx = await context(fs);
		const hash = await writeObject(ctx, "blob", new TextEncoder().encode("#!/bin/sh\n"));

		await checkoutEntry(ctx, { path: "run.sh", hash, mode: 0o100755 });
		expect((await fs.stat("/wt/run.sh")).mode).toBe(0o100755);

		await checkoutEntry(ctx, { path: "run.sh", hash, mode: "100644" });
		expect((await fs.stat("/wt/run.sh")).mode).toBe(0o100644);
	});

	test("a FileSystem without chmod still checks out the file", async () => {
		const fs = new MemoryFileSystem();
		Object.defineProperty(fs, "chmod", { value: undefined });
		const ctx = await context(fs);
		const hash = await writeObject(ctx, "blob", new TextEncoder().encode("#!/bin/sh\n"));

		await checkoutEntry(ctx, { path: "run.sh", hash, mode: 0o100755 });
		expect(await fs.readFile("/wt/run.sh")).toBe("#!/bin/sh\n");
		expect((await fs.stat("/wt/run.sh")).mode).toBe(0o100644);
	});
});

class ModePreservingFs extends MemoryFileSystem {
	override async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const existing = await this.stat(path).catch(() => null);
		await super.writeFile(path, content);
		if (existing) await this.chmod(path, existing.mode);
	}
}

describe("checkoutEntry on a filesystem whose writeFile keeps the old mode", () => {
	test("a 100644 entry over an executable file clears the exec bit", async () => {
		const fs = new ModePreservingFs();
		const ctx = await context(fs);
		const hash = await writeObject(ctx, "blob", new TextEncoder().encode("#!/bin/sh\n"));

		await checkoutEntry(ctx, { path: "run.sh", hash, mode: 0o100755 });
		expect((await fs.stat("/wt/run.sh")).mode).toBe(0o100755);

		await checkoutEntry(ctx, { path: "run.sh", hash, mode: 0o100644 });
		expect((await fs.stat("/wt/run.sh")).mode).toBe(0o100644);
	});
});
