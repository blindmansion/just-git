import { describe, expect, test } from "bun:test";
import { replaceFileDurable } from "../../../src/fs/durable-io.ts";
import {
	createFsRepoStorage,
	recoverFsRepoStorage,
	validateBareRepoLayout,
} from "../../../src/store/fs-repo-storage.ts";
import { replayCrashCuts } from "./crash-harness.ts";
import type { CrashableDurableFileSystem } from "./crashable-durable-fs.ts";
import { assertBareRepoOrAbsent } from "./invariants.ts";

const REPOS = "/repos";
const REPO = `${REPOS}/demo.git`;

describe("filesystem bare repository crash durability", () => {
	test("direct creation publishes only a complete staged repository", async () => {
		await replayCrashCuts({
			setup: async (fs) => {
				await fs.mkdir(REPOS);
			},
			operation: (fs) => createFsRepoStorage(fs, REPO),
			verifyCut: async ({ fs }) => {
				await assertBareRepoOrAbsent(fs, REPO);
				await assertOnlyRecognizedStages(fs);
			},
			verifySuccess: async (fs) => {
				await validateBareRepoLayout(fs, REPO);
				expect((await fs.readdir(REPOS)).filter((name) => name.startsWith(".stage-"))).toEqual([]);
			},
			retry: async (fs) => {
				await createFsRepoStorage(fs, REPO);
				const rebooted = fs.reboot();
				await validateBareRepoLayout(rebooted, REPO);
				expect(
					(await rebooted.readdir(REPOS)).filter((name) => name.startsWith(".stage-")),
				).toEqual([]);
			},
		});
	});

	test("ordinary startup reaps abandoned ref-lock claimants without touching refs", async () => {
		const { CrashableDurableFileSystem } = await import("./crashable-durable-fs.ts");
		const fs = new CrashableDurableFileSystem();
		const repo = await createFsRepoStorage(fs, REPO);
		await repo.putRef("refs/heads/main", { type: "direct", hash: "a".repeat(40) });
		await replaceFileDurable(fs, `${REPO}/.just-git-ref.lock.tmp-abandoned`, "");
		fs.checkpoint();

		const reopened = await createFsRepoStorage(fs, REPO);
		expect(await fs.exists(`${REPO}/.just-git-ref.lock.tmp-abandoned`)).toBe(false);
		expect(await fs.exists(`${REPO}/.just-git-ref.lock`)).toBe(false);
		expect(await reopened.getRef("refs/heads/main")).toEqual({
			type: "direct",
			hash: "a".repeat(40),
		});
	});

	test("ordinary startup never breaks a held ref lock while reaping claimants", async () => {
		const { CrashableDurableFileSystem } = await import("./crashable-durable-fs.ts");
		const fs = new CrashableDurableFileSystem();
		await createFsRepoStorage(fs, REPO);
		await replaceFileDurable(fs, `${REPO}/.just-git-ref.lock`, "");
		await replaceFileDurable(fs, `${REPO}/.just-git-ref.lock.tmp-abandoned`, "");
		fs.checkpoint();

		await createFsRepoStorage(fs, REPO);
		expect(await fs.exists(`${REPO}/.just-git-ref.lock`)).toBe(true);
		expect(await fs.exists(`${REPO}/.just-git-ref.lock.tmp-abandoned`)).toBe(false);
	});

	test("durable ref locks require explicit operator recovery", async () => {
		const { CrashableDurableFileSystem } = await import("./crashable-durable-fs.ts");
		const fs = new CrashableDurableFileSystem();
		const repo = await createFsRepoStorage(fs, REPO);
		await replaceFileDurable(fs, `${REPO}/.just-git-ref.lock`, "");
		fs.checkpoint();

		await expect(
			repo.putRef("refs/heads/main", { type: "direct", hash: "a".repeat(40) }),
		).rejects.toThrow("EEXIST");
		expect(await fs.exists(`${REPO}/.just-git-ref.lock`)).toBe(true);

		const recovered = await recoverFsRepoStorage(fs, REPO);
		await recovered.putRef("refs/heads/main", { type: "direct", hash: "a".repeat(40) });
		expect(await recovered.getRef("refs/heads/main")).toEqual({
			type: "direct",
			hash: "a".repeat(40),
		});
	});
});

async function assertOnlyRecognizedStages(fs: CrashableDurableFileSystem): Promise<void> {
	for (const name of await fs.readdir(REPOS)) {
		if (name === "demo.git") continue;
		expect(name).toMatch(/^\.stage-demo\.git-[a-z0-9-]+$/);
	}
}
