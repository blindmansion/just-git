import { describe, expect, test } from "bun:test";
import { MemoryFileSystem } from "../../src";
import { expireReflogs } from "../../src/commands/gc.ts";
import { collectAllRoots } from "../../src/lib/gc-roots.ts";
import { writeObject } from "../../src/lib/object-db.ts";
import { PackedObjectStore } from "../../src/lib/object-store.ts";
import { appendReflog, readReflogAt } from "../../src/lib/reflog.ts";
import type { GitContext } from "../../src/lib/types.ts";
import { enumerateWorktrees } from "../../src/lib/worktree-admin.ts";
import { FileSystemRefStore } from "../../src/lib/ref-store.ts";

const COMMON = "/repo/.git";

function ctxFor(fs: MemoryFileSystem, gitDir: string): GitContext {
	return {
		fs,
		gitDir,
		commonDir: COMMON,
		workTree: null,
		objectStore: new PackedObjectStore(fs, COMMON),
		refStore: new FileSystemRefStore(fs, gitDir, COMMON),
	};
}

function oldEntry(newHash: string) {
	return {
		oldHash: "0".repeat(40),
		newHash,
		name: "Test",
		email: "test@test.com",
		timestamp: 1,
		tz: "+0000",
		message: "old",
	};
}

describe("enumerateWorktrees", () => {
	test("is empty with no worktrees dir, lists registered worktrees otherwise", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir(COMMON, { recursive: true });
		const ctx = ctxFor(fs, COMMON);

		expect(await enumerateWorktrees(ctx)).toEqual([]);

		await fs.mkdir(`${COMMON}/worktrees/a`, { recursive: true });
		await fs.mkdir(`${COMMON}/worktrees/b`, { recursive: true });
		const ids = (await enumerateWorktrees(ctx)).map((w) => w.id).sort();
		expect(ids).toEqual(["a", "b"]);
	});
});

describe("collectAllRoots across worktrees", () => {
	test("a plain repo collects exactly its own roots", async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir(COMMON, { recursive: true });
		const ctx = ctxFor(fs, COMMON);
		const blob = await writeObject(ctx, "blob", new TextEncoder().encode("x"));
		await ctx.refStore.writeRef("HEAD", { type: "direct", hash: blob });

		expect(await collectAllRoots(ctx)).toEqual([blob]);
	});

	test("keeps an object reachable only from a sibling worktree's HEAD", async () => {
		const fs = new MemoryFileSystem();
		const siblingDir = `${COMMON}/worktrees/wt1`;
		await fs.mkdir(siblingDir, { recursive: true });
		const main = ctxFor(fs, COMMON);

		const siblingOnly = await writeObject(main, "blob", new TextEncoder().encode("sibling"));
		await new FileSystemRefStore(fs, siblingDir, COMMON).writeRef("HEAD", {
			type: "direct",
			hash: siblingOnly,
		});

		// Collecting from the main worktree must still keep the sibling's object.
		expect(await collectAllRoots(main)).toContain(siblingOnly);
	});
});

describe("reflog expiry is repo-wide", () => {
	test("expiring from a linked worktree trims every worktree's HEAD reflog, like git reflog expire --all", async () => {
		const fs = new MemoryFileSystem();
		const siblingDir = `${COMMON}/worktrees/wt1`;
		await fs.mkdir(siblingDir, { recursive: true });

		// The main worktree's HEAD reflog (commonDir/logs/HEAD) has an old entry.
		const mainCtx = ctxFor(fs, COMMON);
		await appendReflog(mainCtx, "HEAD", oldEntry("a".repeat(40)));

		// The linked worktree's own HEAD reflog also has an old entry.
		const linkedCtx = ctxFor(fs, siblingDir);
		await appendReflog(linkedCtx, "HEAD", oldEntry("b".repeat(40)));

		await expireReflogs(linkedCtx);

		// Real git's `gc` runs `reflog expire --all`, expiring every worktree's
		// reflog regardless of which worktree it was invoked from — including the
		// main worktree's logs/HEAD in the common dir and each linked worktree's
		// private logs/HEAD.
		expect(await readReflogAt(fs, `${COMMON}/logs/HEAD`)).toEqual([]);
		expect(await readReflogAt(fs, `${siblingDir}/logs/HEAD`)).toEqual([]);
	});
});
