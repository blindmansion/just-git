import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableFileSystemFromNodeFs } from "../src/fs/node-durable-fs.ts";
import { createRepo } from "../src/store/repo-store.ts";
import { createFsRepoStorage } from "../src/store/fs-repo-storage.ts";

const tempDirs: string[] = [];
const encoder = new TextEncoder();

async function tempRepoPath(name = "repo.git") {
	const root = await nodeFs.mkdtemp(join(tmpdir(), "just-git-fs-repo-"));
	tempDirs.push(root);
	return {
		fs: durableFileSystemFromNodeFs(nodeFs),
		repoDir: join(root, name),
		root,
	};
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => nodeFs.rm(dir, { recursive: true, force: true })),
	);
});

describe("createFsRepoStorage", () => {
	test("creates a durable empty bare layout at a missing path", async () => {
		const { fs, repoDir } = await tempRepoPath();
		const storage = await createFsRepoStorage(fs, repoDir);

		expect(await fs.readFile(join(repoDir, "HEAD"))).toBe("ref: refs/heads/main\n");
		expect(await fs.readFile(join(repoDir, "config"))).toContain("\tbare = true\n");
		expect((await fs.stat(join(repoDir, "objects"))).isDirectory).toBe(true);
		expect((await fs.stat(join(repoDir, "refs", "heads"))).isDirectory).toBe(true);
		expect((await fs.stat(join(repoDir, "refs", "tags"))).isDirectory).toBe(true);
		expect(await storage.getRef("HEAD")).toEqual({
			type: "symbolic",
			target: "refs/heads/main",
		});
	});

	test("composes object and ref storage for createRepo", async () => {
		const { fs, repoDir } = await tempRepoPath();
		const repo = await createRepo(await createFsRepoStorage(fs, repoDir));
		const content = encoder.encode("filesystem-backed");
		const hash = await repo.objectStore.write("blob", content);
		await repo.refStore.writeRef("refs/heads/main", hash);

		const reopened = await createFsRepoStorage(fs, repoDir);
		expect((await reopened.getObject(hash))?.content).toEqual(content);
		expect(await reopened.getRef("refs/heads/main")).toEqual({ type: "direct", hash });
		expect(await reopened.getRef("HEAD")).toEqual({
			type: "symbolic",
			target: "refs/heads/main",
		});
	});

	test("opens an existing bare repository without rewriting its data", async () => {
		const { fs, repoDir } = await tempRepoPath();
		const storage = await createFsRepoStorage(fs, repoDir);
		const customConfig =
			"# preserve this comment\n[core]\n\trepositoryformatversion = 0\n\tbare = true\n";
		await fs.writeFile(join(repoDir, "config"), customConfig);
		await storage.putRef("HEAD", { type: "symbolic", target: "refs/heads/trunk" });
		const content = encoder.encode("preserved");
		const repo = await createRepo(storage);
		const hash = await repo.objectStore.write("blob", content);

		const reopened = await createFsRepoStorage(fs, repoDir);

		expect(await fs.readFile(join(repoDir, "config"))).toBe(customConfig);
		expect(await fs.readFile(join(repoDir, "HEAD"))).toBe("ref: refs/heads/trunk\n");
		expect((await reopened.getObject(hash))?.content).toEqual(content);
	});

	test("rejects existing incomplete or incorrectly typed layouts", async () => {
		const incomplete = await tempRepoPath("incomplete.git");
		await incomplete.fs.mkdir(incomplete.repoDir);
		expect(createFsRepoStorage(incomplete.fs, incomplete.repoDir)).rejects.toThrow(
			"missing required file",
		);

		const wrongType = await tempRepoPath("wrong-type.git");
		await wrongType.fs.mkdir(wrongType.repoDir);
		await wrongType.fs.writeFile(join(wrongType.repoDir, "HEAD"), "ref: refs/heads/main\n");
		await wrongType.fs.writeFile(
			join(wrongType.repoDir, "config"),
			"[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
		);
		await wrongType.fs.writeFile(join(wrongType.repoDir, "objects"), "");
		await wrongType.fs.mkdir(join(wrongType.repoDir, "refs"));
		expect(createFsRepoStorage(wrongType.fs, wrongType.repoDir)).rejects.toThrow("not a directory");
	});

	test("rejects non-bare, unsupported, and invalid-HEAD repositories", async () => {
		const nonBare = await tempRepoPath("non-bare.git");
		await createFsRepoStorage(nonBare.fs, nonBare.repoDir);
		await nonBare.fs.writeFile(
			join(nonBare.repoDir, "config"),
			"[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
		);
		expect(createFsRepoStorage(nonBare.fs, nonBare.repoDir)).rejects.toThrow(
			"not configured as bare",
		);

		const unsupported = await tempRepoPath("sha256.git");
		await createFsRepoStorage(unsupported.fs, unsupported.repoDir);
		await unsupported.fs.writeFile(
			join(unsupported.repoDir, "config"),
			[
				"[core]",
				"\trepositoryformatversion = 1",
				"\tbare = true",
				"[extensions]",
				"\tobjectformat = sha256",
				"",
			].join("\n"),
		);
		expect(createFsRepoStorage(unsupported.fs, unsupported.repoDir)).rejects.toThrow(
			"unsupported bare repository format",
		);

		const invalidHead = await tempRepoPath("invalid-head.git");
		await createFsRepoStorage(invalidHead.fs, invalidHead.repoDir);
		await invalidHead.fs.writeFile(join(invalidHead.repoDir, "HEAD"), "not-an-object-id\n");
		expect(createFsRepoStorage(invalidHead.fs, invalidHead.repoDir)).rejects.toThrow(
			"invalid bare repository HEAD",
		);
	});

	test("does not follow native alternates", async () => {
		const { fs, root } = await tempRepoPath();
		const parentDir = join(root, "parent.git");
		const childDir = join(root, "child.git");
		const parent = await createFsRepoStorage(fs, parentDir);
		const content = encoder.encode("parent-only");
		const parentRepo = await createRepo(parent);
		const hash = await parentRepo.objectStore.write("blob", content);
		await createFsRepoStorage(fs, childDir);
		await fs.mkdir(join(childDir, "objects", "info"), { recursive: true });
		await fs.writeFile(
			join(childDir, "objects", "info", "alternates"),
			`${join(parentDir, "objects")}\n`,
		);

		const child = await createFsRepoStorage(fs, childDir);
		expect(await child.getObject(hash)).toBeNull();
	});

	test("requires an absolute normalized repository path", async () => {
		const { fs, repoDir } = await tempRepoPath();
		expect(createFsRepoStorage(fs, "relative.git")).rejects.toThrow(
			"must be absolute and normalized",
		);
		expect(createFsRepoStorage(fs, `${repoDir}/../escaped.git`)).rejects.toThrow(
			"must be absolute and normalized",
		);
	});
});
