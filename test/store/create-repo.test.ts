import { describe, expect, test } from "bun:test";
import { createMemoryRepoStorage } from "../../src/store/memory-storage.ts";
import { createRepo } from "../../src/store/repo-store.ts";

describe("createRepo", () => {
	test("creates an isolated in-memory repo by default", async () => {
		const repo = await createRepo();

		expect(await repo.refStore.readRef("HEAD")).toEqual({
			type: "symbolic",
			target: "refs/heads/main",
		});

		const hash = await repo.objectStore.write("blob", new TextEncoder().encode("hello"));
		expect(new TextDecoder().decode((await repo.objectStore.read(hash)).content)).toBe("hello");
	});

	test("uses supplied storage without replacing HEAD", async () => {
		const storage = createMemoryRepoStorage();
		await storage.putRef("HEAD", {
			type: "symbolic",
			target: "refs/heads/develop",
		});

		const repo = await createRepo(storage);

		expect(await repo.refStore.readRef("HEAD")).toEqual({
			type: "symbolic",
			target: "refs/heads/develop",
		});
	});
});
