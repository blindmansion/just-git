import { expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableFileSystemFromNodeFs } from "../../src/fs/node-durable-fs.ts";
import { createFsRepoPool } from "../../src/store/fs-repo-pool.ts";
import { createRealGitHome, createSandbox, realGit, startServer } from "./util.ts";

test("filesystem backend supports a real Git protocol v2 clone", async () => {
	const root = await nodeFs.mkdtemp(join(tmpdir(), "just-git-fs-server-"));
	const home = await createRealGitHome();
	const sandbox = await createSandbox("just-git-fs-realclient-");
	const pool = await createFsRepoPool(durableFileSystemFromNodeFs(nodeFs), root);
	const { srv, port } = startServer({ storage: pool, autoCreate: true });

	try {
		const sourceDir = join(sandbox, "source");
		const cloneDir = join(sandbox, "clone");
		expect(await realGit(home, sandbox, `init -b main ${sourceDir}`)).toMatchObject({
			exitCode: 0,
		});
		await nodeFs.writeFile(join(sourceDir, "README.md"), "hello\n");
		expect(await realGit(home, sourceDir, "add README.md")).toMatchObject({ exitCode: 0 });
		expect(await realGit(home, sourceDir, "commit -m initial")).toMatchObject({ exitCode: 0 });
		expect(await realGit(home, sourceDir, `push http://localhost:${port}/demo main`)).toMatchObject(
			{ exitCode: 0 },
		);

		const sourceHead = (await realGit(home, sourceDir, "rev-parse HEAD")).stdout.trim();
		expect(
			await realGit(
				home,
				sandbox,
				`-c protocol.version=2 clone http://localhost:${port}/demo ${cloneDir}`,
			),
		).toMatchObject({ exitCode: 0 });
		expect((await realGit(home, cloneDir, "rev-parse HEAD")).stdout.trim()).toBe(sourceHead);
		expect(await nodeFs.readFile(join(cloneDir, "README.md"), "utf8")).toBe("hello\n");

		const [shard] = await nodeFs.readdir(join(root, "repos"));
		const [repoName] = await nodeFs.readdir(join(root, "repos", shard!));
		const repoDir = join(root, "repos", shard!, repoName!);
		expect(await realGit(home, sandbox, `--git-dir ${repoDir} fsck --full`)).toMatchObject({
			exitCode: 0,
		});
	} finally {
		srv.stop();
		await Promise.all([
			nodeFs.rm(root, { recursive: true, force: true }),
			nodeFs.rm(home, { recursive: true, force: true }),
			nodeFs.rm(sandbox, { recursive: true, force: true }),
		]);
	}
});
