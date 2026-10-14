import { describe, expect, test } from "bun:test";
import type { FileStat } from "../../src/fs";
import { createGit } from "../../src/git";
import {
	defaultStat,
	gitModeFromFileStat,
	indexStatFromFileStat,
	indexStatMatchesFile,
	readIndex,
	worktreeMode,
	worktreeModePolicy,
} from "../../src/lib/index";
import { findRepo } from "../../src/lib/repo";
import type { IndexEntry } from "../../src/lib/types";
import { MemoryFileSystem } from "../../src/memory-fs";

const policy = worktreeModePolicy(new MemoryFileSystem());

function regularStat(overrides: Partial<FileStat> = {}): FileStat {
	return {
		isFile: true,
		isDirectory: false,
		isSymbolicLink: false,
		mode: 0o100644,
		size: 12,
		mtime: new Date("2026-09-04T12:00:00.123Z"),
		...overrides,
	};
}

function entryFor(stat: FileStat): IndexEntry {
	return {
		path: "file.txt",
		mode: gitModeFromFileStat(stat),
		hash: "0123456789012345678901234567890123456789",
		stage: 0,
		stat: indexStatFromFileStat(stat),
	};
}

describe("index stat cache", () => {
	test("matches an unchanged regular file older than the index", () => {
		const stat = regularStat();
		const entry = entryFor(stat);

		expect(indexStatMatchesFile(policy, entry, stat, new Date("2026-09-04T12:00:01Z"))).toBe(true);
	});

	test("an exec-bit change misses the cache unless core.fileMode is false", () => {
		const stat = regularStat();
		const entry = entryFor(stat);
		const chmodded = { ...stat, mode: 0o100755 };
		const timestamp = new Date("2026-09-04T12:00:01Z");

		expect(indexStatMatchesFile(policy, entry, chmodded, timestamp)).toBe(false);
		const noFileMode = worktreeModePolicy(new MemoryFileSystem(), false);
		expect(indexStatMatchesFile(noFileMode, entry, chmodded, timestamp)).toBe(true);
	});

	test("rejects zero/default stat data", () => {
		const stat = regularStat();
		const entry = { ...entryFor(stat), stat: defaultStat() };

		expect(indexStatMatchesFile(policy, entry, stat, new Date("2026-09-04T12:00:01Z"))).toBe(false);
	});

	test("missing runtime timestamps degrade to hashing", () => {
		const stat = regularStat();
		const entry = entryFor(stat);
		const withoutMtime = { ...stat, mtime: undefined } as unknown as FileStat;

		expect(indexStatFromFileStat(withoutMtime).mtimeSeconds).toBe(0);
		expect(
			indexStatMatchesFile(policy, entry, withoutMtime, new Date("2026-09-04T12:00:01Z")),
		).toBe(false);
	});

	test("rejects size and mode changes", () => {
		const stat = regularStat();
		const entry = entryFor(stat);

		expect(
			indexStatMatchesFile(
				policy,
				entry,
				{ ...stat, size: stat.size + 1 },
				new Date("2026-09-04T12:00:01Z"),
			),
		).toBe(false);
		expect(
			indexStatMatchesFile(
				policy,
				entry,
				{ ...stat, mode: 0o100755 },
				new Date("2026-09-04T12:00:01Z"),
			),
		).toBe(false);
	});

	test("rejects racily clean files at the index timestamp", () => {
		const stat = regularStat();
		const entry = entryFor(stat);

		expect(indexStatMatchesFile(policy, entry, stat, stat.mtime)).toBe(false);
	});

	test("rejects symlinks even when their metadata matches", () => {
		const stat = regularStat({
			isFile: false,
			isSymbolicLink: true,
			mode: 0o120000,
		});
		const entry = entryFor(stat);

		expect(indexStatMatchesFile(policy, entry, stat, new Date("2026-09-04T12:00:01Z"))).toBe(false);
	});

	test("uses optional ctime and identity fields when available", () => {
		const stat = regularStat({
			ctime: new Date("2026-09-04T11:59:59.456Z"),
			dev: 7,
			ino: 11,
			uid: 501,
			gid: 20,
		});
		const entry = entryFor(stat);
		const indexTimestamp = new Date("2026-09-04T12:00:01Z");

		expect(indexStatMatchesFile(policy, entry, stat, indexTimestamp)).toBe(true);
		expect(indexStatMatchesFile(policy, entry, { ...stat, ino: 12 }, indexTimestamp)).toBe(false);
		expect(
			indexStatMatchesFile(
				policy,
				entry,
				{ ...stat, ctime: new Date("2026-09-04T11:59:58Z") },
				indexTimestamp,
			),
		).toBe(false);
	});

	test("accepts bigint dev/ino and keeps the low 32 bits", () => {
		const stat = regularStat({ dev: 7n, ino: 0x1_0000_000bn });
		const entry = entryFor(stat);
		const indexTimestamp = new Date("2026-09-04T12:00:01Z");

		expect(entry.stat.dev).toBe(7);
		expect(entry.stat.ino).toBe(11);
		expect(indexStatMatchesFile(policy, entry, stat, indexTimestamp)).toBe(true);
		// Same truncated value given as a number still matches.
		expect(indexStatMatchesFile(policy, entry, { ...stat, dev: 7, ino: 11 }, indexTimestamp)).toBe(
			true,
		);
		expect(indexStatMatchesFile(policy, entry, { ...stat, ino: 12n }, indexTimestamp)).toBe(false);
		expect(indexStatMatchesFile(policy, entry, { ...stat, dev: 8n }, indexTimestamp)).toBe(false);
	});

	test("negative bigint dev/ino are stored as zero and disable the shortcut", () => {
		const stat = regularStat({ dev: -1n, ino: 11n });
		const entry = entryFor(stat);

		expect(entry.stat.dev).toBe(0);
		expect(indexStatMatchesFile(policy, entry, stat, new Date("2026-09-04T12:00:01Z"))).toBe(false);
	});

	test("bigint dev/ino round-trip through the on-disk index", async () => {
		class BigintStatFs extends MemoryFileSystem {
			override async stat(path: string): Promise<FileStat> {
				return { ...(await super.stat(path)), dev: 0x2_0000_0003n, ino: 0xffff_ffff_ffffn };
			}
			override async lstat(path: string): Promise<FileStat> {
				return { ...(await super.lstat(path)), dev: 0x2_0000_0003n, ino: 0xffff_ffff_ffffn };
			}
		}
		const bigFs = new BigintStatFs();
		const git = createGit({ fs: bigFs, cwd: "/repo" });
		await git.exec("init");
		await bigFs.writeFile("/repo/file.txt", "hello\n");
		// Let the clock move past the file's mtime so `add` doesn't treat the
		// entry as racily clean and zero its stat data.
		await Bun.sleep(5);
		expect((await git.exec("add file.txt")).exitCode).toBe(0);

		const ctx = await findRepo(bigFs, "/repo");
		const index = await readIndex(ctx!);
		const entry = index.entries.find((e) => e.path === "file.txt")!;
		expect(entry.stat.dev).toBe(3);
		expect(entry.stat.ino).toBe(0xffff_ffff);
		const current = await bigFs.lstat("/repo/file.txt");
		expect(
			indexStatMatchesFile(
				worktreeModePolicy(bigFs),
				entry,
				current,
				new Date(Date.now() + 60_000),
			),
		).toBe(true);
	});
});

describe("worktreeMode", () => {
	const fileModeFalse = worktreeModePolicy(new MemoryFileSystem(), false);
	const exec = { ...regularStat(), mode: 0o100755 };
	const plain = regularStat();

	test("core.fileMode=false keeps a tracked file's index mode", () => {
		expect(worktreeMode(fileModeFalse, { mode: 0o100644 }, exec)).toBe(0o100644);
		expect(worktreeMode(fileModeFalse, { mode: 0o100755 }, plain)).toBe(0o100755);
		expect(worktreeMode(policy, { mode: 0o100644 }, exec)).toBe(0o100755);
	});

	test("core.fileMode=false records a new file as 100644", () => {
		expect(worktreeMode(fileModeFalse, undefined, exec)).toBe(0o100644);
		expect(worktreeMode(policy, undefined, exec)).toBe(0o100755);
	});

	test("a FileSystem without chmod never trusts the exec bit", () => {
		const fs = new MemoryFileSystem();
		Object.defineProperty(fs, "chmod", { value: undefined });
		expect(worktreeModePolicy(fs, true).fileMode).toBe(false);
	});
});
