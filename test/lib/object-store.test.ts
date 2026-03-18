import { describe, expect, test } from "bun:test";
import { hashObject } from "../../src/lib/object-db";
import { PackedObjectStore } from "../../src/lib/object-store";
import { buildPackIndex, PackIndex } from "../../src/lib/pack/pack-index";
import { PackReader } from "../../src/lib/pack/pack-reader";
import { writePack } from "../../src/lib/pack/packfile";
import { inflate } from "../../src/lib/pack/zlib";
import { findRepo } from "../../src/lib/repo";
import { BASIC_REPO, TEST_ENV } from "../fixtures";
import { createTestBash } from "../util";

// ── Pack index + PackReader ─────────────────────────────────────────

describe("PackIndex", () => {
	test("buildPackIndex round-trips through PackIndex.lookup", async () => {
		const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');
		await bash.exec('echo "line2" >> /repo/README.md');
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');

		const log = await bash.exec("git log --oneline");
		expect(log.stdout.trim().split("\n")).toHaveLength(2);

		const objectsDir = "/repo/.git/objects";
		const fanoutDirs = await bash.fs.readdir(objectsDir);
		const hexDirs = fanoutDirs.filter((d) => /^[0-9a-f]{2}$/.test(d));

		const objects: {
			type: "blob" | "tree" | "commit" | "tag";
			content: Uint8Array;
			hash: string;
		}[] = [];
		for (const hexDir of hexDirs) {
			const entries = await bash.fs.readdir(`${objectsDir}/${hexDir}`);
			for (const entry of entries) {
				const raw = await bash.fs.readFileBuffer(`${objectsDir}/${hexDir}/${entry}`);
				const inflated = await inflate(raw);
				const nullIdx = inflated.indexOf(0);
				const header = new TextDecoder().decode(inflated.subarray(0, nullIdx));
				const type = header.split(" ")[0] as "blob" | "tree" | "commit" | "tag";
				const content = inflated.subarray(nullIdx + 1);
				objects.push({ type, content, hash: hexDir + entry });
			}
		}
		expect(objects.length).toBeGreaterThan(0);

		const packData = await writePack(objects);
		const idxData = await buildPackIndex(packData);
		const idx = new PackIndex(idxData);

		expect(idx.objectCount).toBe(objects.length);

		for (const obj of objects) {
			expect(idx.has(obj.hash)).toBe(true);
			const offset = idx.lookup(obj.hash);
			expect(offset).not.toBeNull();
			expect(typeof offset).toBe("number");
		}

		expect(idx.lookup("0000000000000000000000000000000000000000")).toBeNull();
	});

	test("PackReader reads objects from pack via index", async () => {
		const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const objectsDir = "/repo/.git/objects";
		const fanoutDirs = await bash.fs.readdir(objectsDir);
		const hexDirs = fanoutDirs.filter((d) => /^[0-9a-f]{2}$/.test(d));

		const objects: {
			type: "blob" | "tree" | "commit" | "tag";
			content: Uint8Array;
			hash: string;
		}[] = [];
		for (const hexDir of hexDirs) {
			const entries = await bash.fs.readdir(`${objectsDir}/${hexDir}`);
			for (const entry of entries) {
				const raw = await bash.fs.readFileBuffer(`${objectsDir}/${hexDir}/${entry}`);
				const inflated = await inflate(raw);
				const nullIdx = inflated.indexOf(0);
				const header = new TextDecoder().decode(inflated.subarray(0, nullIdx));
				const type = header.split(" ")[0] as "blob" | "tree" | "commit" | "tag";
				const content = inflated.subarray(nullIdx + 1);
				objects.push({ type, content, hash: hexDir + entry });
			}
		}

		const packData = await writePack(objects);
		const idxData = await buildPackIndex(packData);
		const reader = new PackReader(packData, idxData);

		expect(reader.objectCount).toBe(objects.length);

		for (const obj of objects) {
			expect(reader.hasObject(obj.hash)).toBe(true);
			const read = await reader.readObject(obj.hash);
			expect(read).not.toBeNull();
			expect(read?.type).toBe(obj.type);
			expect(read?.content).toEqual(obj.content);
		}

		const missing = await reader.readObject("0000000000000000000000000000000000000000");
		expect(missing).toBeNull();
	});
});

// ── PackedObjectStore ───────────────────────────────────────────────

describe("PackedObjectStore", () => {
	test("objects on disk are zlib-compressed", async () => {
		const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
		await bash.exec("git init");
		await bash.exec("git add .");
		const commitResult = await bash.exec('git commit -m "initial"');
		expect(commitResult.exitCode).toBe(0);

		const objectsDir = "/repo/.git/objects";
		const fanoutDirs = await bash.fs.readdir(objectsDir);
		const hexDirs = fanoutDirs.filter((d) => /^[0-9a-f]{2}$/.test(d));
		expect(hexDirs.length).toBeGreaterThan(0);

		for (const hexDir of hexDirs) {
			const entries = await bash.fs.readdir(`${objectsDir}/${hexDir}`);
			for (const entry of entries) {
				const raw = await bash.fs.readFileBuffer(`${objectsDir}/${hexDir}/${entry}`);
				if (raw.length === 0) continue;
				const firstByte = raw[0];
				if (firstByte === undefined) continue;
				expect(firstByte).toBe(0x78);

				const inflated = await inflate(raw);
				const nullIdx = inflated.indexOf(0);
				expect(nullIdx).toBeGreaterThan(0);
				const header = new TextDecoder().decode(inflated.subarray(0, nullIdx));
				expect(header).toMatch(/^(blob|tree|commit|tag) \d+$/);
			}
		}
	});

	test("full workflow: init, add, commit, log, diff, branch, merge", async () => {
		const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });

		const init = await bash.exec("git init");
		expect(init.exitCode).toBe(0);

		await bash.exec("git add .");
		const c1 = await bash.exec('git commit -m "initial"');
		expect(c1.exitCode).toBe(0);
		expect(c1.stdout).toContain("initial");

		const log1 = await bash.exec("git log --oneline");
		expect(log1.exitCode).toBe(0);
		expect(log1.stdout).toContain("initial");

		await bash.exec("git checkout -b feature");
		await bash.exec('echo "new feature" > /repo/src/feature.ts');
		await bash.exec("git add .");
		const c2 = await bash.exec('git commit -m "add feature"');
		expect(c2.exitCode).toBe(0);

		await bash.exec("git checkout main");
		const merge = await bash.exec("git merge feature");
		expect(merge.exitCode).toBe(0);

		const log2 = await bash.exec("git log --oneline");
		expect(log2.exitCode).toBe(0);
		expect(log2.stdout).toContain("add feature");
		expect(log2.stdout).toContain("initial");

		const diff = await bash.exec("git diff");
		expect(diff.exitCode).toBe(0);
		expect(diff.stdout).toBe("");
	});

	test("amend, reset, stash work correctly", async () => {
		const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });

		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');

		await bash.exec('echo "updated" > /repo/README.md');
		await bash.exec("git add .");
		const amend = await bash.exec('git commit --amend -m "first (amended)"');
		expect(amend.exitCode).toBe(0);

		const log = await bash.exec("git log --oneline");
		expect(log.stdout).toContain("first (amended)");
		expect(log.stdout.trim().split("\n")).toHaveLength(1);

		await bash.exec('echo "wip" > /repo/src/main.ts');
		const stash = await bash.exec("git stash push");
		expect(stash.exitCode).toBe(0);

		const main = await bash.fs.readFile("/repo/src/main.ts");
		expect(main).toBe('console.log("hello world");');

		const pop = await bash.exec("git stash pop");
		expect(pop.exitCode).toBe(0);
		const mainAfter = await bash.fs.readFile("/repo/src/main.ts");
		expect(mainAfter).toBe("wip\n");

		await bash.exec("git add .");
		await bash.exec('git commit -m "wip commit"');
		const resetTarget = await bash.exec("git rev-parse HEAD~1");
		const reset = await bash.exec(`git reset --hard ${resetTarget.stdout.trim()}`);
		expect(reset.exitCode).toBe(0);
	});

	test("ingestPack retains pack files and reads from them", async () => {
		const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const objectsDir = "/repo/.git/objects";
		const fanoutDirs = await bash.fs.readdir(objectsDir);
		const hexDirs = fanoutDirs.filter((d) => /^[0-9a-f]{2}$/.test(d));

		const objects: {
			type: "blob" | "tree" | "commit" | "tag";
			content: Uint8Array;
		}[] = [];
		for (const hexDir of hexDirs) {
			const entries = await bash.fs.readdir(`${objectsDir}/${hexDir}`);
			for (const entry of entries) {
				const raw = await bash.fs.readFileBuffer(`${objectsDir}/${hexDir}/${entry}`);
				const inflated = await inflate(raw);
				const nullIdx = inflated.indexOf(0);
				const header = new TextDecoder().decode(inflated.subarray(0, nullIdx));
				const type = header.split(" ")[0] as "blob" | "tree" | "commit" | "tag";
				const content = inflated.subarray(nullIdx + 1);
				objects.push({ type, content });
			}
		}

		const packData = await writePack(objects);

		const bash2 = createTestBash({ env: TEST_ENV });
		await bash2.exec("git init");

		const packDir = "/repo/.git/objects/pack";
		expect(await bash2.fs.exists(packDir)).toBe(false);

		const ctx = await findRepo(bash2.fs, "/repo");
		expect(ctx).not.toBeNull();

		const store = new PackedObjectStore(bash2.fs, ctx?.gitDir ?? "");
		const count = await store.ingestPack(packData);
		expect(count).toBe(objects.length);

		expect(await bash2.fs.exists(packDir)).toBe(true);
		const packFiles = await bash2.fs.readdir(packDir);
		const packs = packFiles.filter((f: string) => f.endsWith(".pack"));
		const idxs = packFiles.filter((f: string) => f.endsWith(".idx"));
		expect(packs.length).toBe(1);
		expect(idxs.length).toBe(1);

		for (const obj of objects) {
			const hash = await hashObject(obj.type, obj.content);
			expect(await store.exists(hash)).toBe(true);
			const read = await store.read(hash);
			expect(read.type).toBe(obj.type);
			expect(read.content).toEqual(obj.content);
		}
	});
});

// ── packed-refs support ─────────────────────────────────────────────

describe("packed-refs", () => {
	test("resolveRef falls back to packed-refs when loose file is absent", async () => {
		const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const hash = (await bash.exec("git rev-parse HEAD")).stdout.trim();
		expect(hash).toHaveLength(40);

		const packedContent = `# pack-refs with: peeled fully-peeled sorted\n${hash} refs/heads/main\n`;
		await bash.fs.writeFile("/repo/.git/packed-refs", packedContent);
		await bash.fs.rm("/repo/.git/refs/heads/main");

		const resolved = await bash.exec("git rev-parse refs/heads/main");
		expect(resolved.exitCode).toBe(0);
		expect(resolved.stdout.trim()).toBe(hash);

		const branch = await bash.exec("git branch");
		expect(branch.exitCode).toBe(0);
		expect(branch.stdout).toContain("main");
	});

	test("loose refs take precedence over packed-refs", async () => {
		const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');
		const hash1 = (await bash.exec("git rev-parse HEAD")).stdout.trim();

		await bash.exec('echo "change" >> /repo/README.md');
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');
		const hash2 = (await bash.exec("git rev-parse HEAD")).stdout.trim();

		const packedContent = `${hash1} refs/heads/main\n`;
		await bash.fs.writeFile("/repo/.git/packed-refs", packedContent);

		const resolved = await bash.exec("git rev-parse refs/heads/main");
		expect(resolved.stdout.trim()).toBe(hash2);
	});

	test("listRefs includes packed refs not present as loose files", async () => {
		const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');
		const hash = (await bash.exec("git rev-parse HEAD")).stdout.trim();

		const packedContent = `${hash} refs/heads/main\n${hash} refs/heads/packed-only\n`;
		await bash.fs.writeFile("/repo/.git/packed-refs", packedContent);

		const branches = await bash.exec("git branch");
		expect(branches.stdout).toContain("main");
		expect(branches.stdout).toContain("packed-only");
	});
});
