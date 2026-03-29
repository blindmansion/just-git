import { describe, expect, test } from "bun:test";
import { resolveHead } from "../../src/lib/refs.ts";
import { findRepo } from "../../src/lib/repo.ts";
import {
	collectEnumeration,
	enumerateObjects,
	enumerateObjectsWithContent,
} from "../../src/lib/transport/object-walk.ts";
import type { GitRepo, ObjectId, RawObject } from "../../src/lib/types.ts";
import { TEST_ENV as ENV } from "../fixtures";
import { createTestBash } from "../util";

async function setupRepo(files: Record<string, string> = {}) {
	const bash = createTestBash({
		files: { "/repo/README.md": "# Hello", ...files },
		env: ENV,
	});
	await bash.exec("git init");
	return bash;
}

describe("enumerateObjects (with haves)", () => {
	test("excludes objects reachable from haves", async () => {
		const bash = await setupRepo();
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');

		const ctx = (await findRepo(bash.fs, "/repo"))!;
		const firstCommit = (await resolveHead(ctx))!;

		await bash.exec("echo 'new content' > /repo/file2.txt");
		await bash.exec("git add .");
		await bash.exec('git commit -m "second"');

		const secondCommit = (await resolveHead(ctx))!;

		const { count, objects } = await enumerateObjects(ctx, [secondCommit], [firstCommit]);
		const collected = await collectEnumeration({ count, objects });

		expect(count).toBe(collected.length);

		const commits = collected.filter((o) => o.type === "commit");
		expect(commits).toHaveLength(1);
		expect(commits[0]!.hash).toBe(secondCommit);

		expect(collected.find((o) => o.hash === firstCommit)).toBeUndefined();
	});

	test("returns empty when wants are subset of haves", async () => {
		const bash = await setupRepo();
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const ctx = (await findRepo(bash.fs, "/repo"))!;
		const head = (await resolveHead(ctx))!;

		const { count } = await enumerateObjects(ctx, [head], [head]);
		expect(count).toBe(0);
	});

	test("count matches iterated length", async () => {
		const bash = await setupRepo();
		await bash.exec("git add .");
		await bash.exec('git commit -m "first"');

		const ctx = (await findRepo(bash.fs, "/repo"))!;
		const head = (await resolveHead(ctx))!;

		const result = await enumerateObjects(ctx, [head], []);
		const collected = await collectEnumeration(result);
		expect(result.count).toBe(collected.length);
		expect(collected.length).toBeGreaterThan(0);
	});
});

describe("enumerateObjectsWithContent", () => {
	test("yields objects with content lazily", async () => {
		const bash = await setupRepo();
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');

		const ctx = (await findRepo(bash.fs, "/repo"))!;
		const head = (await resolveHead(ctx))!;

		const { count, objects } = await enumerateObjectsWithContent(ctx, [head], []);
		expect(count).toBeGreaterThan(0);

		const collected = [];
		for await (const obj of objects) {
			expect(obj.content).toBeInstanceOf(Uint8Array);
			expect(obj.content.byteLength).toBeGreaterThanOrEqual(0);
			collected.push(obj);
		}

		expect(collected.length).toBe(count);

		const blob = collected.find((o) => o.type === "blob");
		expect(blob).toBeDefined();
		expect(new TextDecoder().decode(blob!.content)).toBe("# Hello");
	});

	test("count matches enumerateObjects count", async () => {
		const bash = await setupRepo({
			"/repo/a.txt": "file a",
			"/repo/b.txt": "file b",
		});
		await bash.exec("git add .");
		await bash.exec('git commit -m "multi"');

		const ctx = (await findRepo(bash.fs, "/repo"))!;
		const head = (await resolveHead(ctx))!;

		const withoutContent = await enumerateObjects(ctx, [head], []);
		const withContent = await enumerateObjectsWithContent(ctx, [head], []);
		expect(withContent.count).toBe(withoutContent.count);
	});

	test("does not re-read objects during content enumeration", async () => {
		const bash = await setupRepo({
			"/repo/a.txt": "file a",
			"/repo/b.txt": "file b",
		});
		await bash.exec("git add .");
		await bash.exec('git commit -m "multi"');

		const ctx = (await findRepo(bash.fs, "/repo"))!;
		const head = (await resolveHead(ctx))!;
		const readCounts = new Map<ObjectId, number>();
		const countingRepo: GitRepo = {
			...ctx,
			objectStore: {
				...ctx.objectStore,
				async read(hash: ObjectId): Promise<RawObject> {
					readCounts.set(hash, (readCounts.get(hash) ?? 0) + 1);
					return ctx.objectStore.read(hash);
				},
			},
		};

		const result = await enumerateObjectsWithContent(countingRepo, [head], []);
		const collected = await collectEnumeration(result);

		expect(collected.length).toBe(result.count);
		for (const obj of collected) {
			expect(readCounts.get(obj.hash)).toBe(1);
		}
	});
});
