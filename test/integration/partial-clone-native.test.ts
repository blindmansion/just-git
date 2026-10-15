import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createGit, MemoryFileSystem } from "../../src/index.ts";
import { setConfigValue } from "../../src/lib/config.ts";
import {
	buildCommit,
	fetchObjects,
	readCommit,
	readBlob,
	resolveRef,
	flattenTree,
} from "../../src/repo/index.ts";

test("filtered native HTTP fetch hydrates only requested blobs and preserves unrequested files on push", async () => {
	const directory = await mkdtemp(join(tmpdir(), "just-git-partial-"));
	const remote = join(directory, "remote.git");
	const source = join(directory, "source");
	const git = (cwd: string, args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git(directory, ["init", "--bare", "--initial-branch=main", remote]);
	for (const [key, value] of [
		["http.receivepack", "true"],
		["uploadpack.allowFilter", "true"],
		["uploadpack.allowReachableSHA1InWant", "true"],
	])
		git(remote, ["config", key!, value!]);
	git(directory, ["init", "--initial-branch=main", source]);
	git(source, ["config", "user.name", "test"]);
	git(source, ["config", "user.email", "test@example.com"]);
	await mkdir(join(source, "A"));
	await mkdir(join(source, "B"));
	await writeFile(join(source, "A/file.md"), "Local file.\n");
	await writeFile(join(source, "A/state.bin"), randomBytes(1024));
	await writeFile(join(source, "B/large.bin"), randomBytes(2 * 1024 * 1024));
	await writeFile(join(source, "B/state.bin"), randomBytes(128 * 1024));
	git(source, ["add", "."]);
	git(source, ["commit", "-m", "fixture"]);
	git(source, ["remote", "add", "origin", remote]);
	git(source, ["push", "origin", "main"]);
	git(remote, [
		"-c",
		"user.name=test",
		"-c",
		"user.email=test@example.com",
		"tag",
		"-a",
		"fixture",
		"-m",
		"fixture",
		"main",
	]);
	let downloaded = 0;
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.headers.get("authorization") !== "Basic " + btoa("test:secret"))
				return new Response("Unauthorized", { status: 401 });
			const url = new URL(request.url);
			const bytes = new Uint8Array(await request.arrayBuffer());
			const process = Bun.spawn(["git", "http-backend"], {
				stdin: bytes,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...Bun.env,
					GIT_PROJECT_ROOT: directory,
					GIT_HTTP_EXPORT_ALL: "1",
					PATH_INFO: url.pathname,
					QUERY_STRING: url.search.slice(1),
					REQUEST_METHOD: request.method,
					CONTENT_TYPE: request.headers.get("content-type") ?? "",
					CONTENT_LENGTH: String(bytes.length),
					REMOTE_USER: "test",
				},
			});
			const [data] = await Promise.all([
				new Response(process.stdout).arrayBuffer(),
				new Response(process.stderr).arrayBuffer(),
				process.exited,
			]);
			const raw = Buffer.from(data);
			let offset = raw.indexOf("\r\n\r\n"),
				length = 4;
			if (offset < 0) {
				offset = raw.indexOf("\n\n");
				length = 2;
			}
			if (offset < 0) return new Response("Invalid CGI response", { status: 500 });
			const headers = new Headers();
			let status = 200;
			for (const line of raw.subarray(0, offset).toString().split(/\r?\n/)) {
				const colon = line.indexOf(":");
				if (line.slice(0, colon).toLowerCase() === "status")
					status = Number(
						line
							.slice(colon + 1)
							.trim()
							.split(" ")[0],
					);
				else headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
			}
			return new Response(raw.subarray(offset + length), { status, headers });
		},
	});
	try {
		const fs = new MemoryFileSystem();
		const makeClient = () =>
			createGit({
				fs,
				cwd: "/repo",
				credentials: () => ({ type: "basic", username: "test", password: "secret" }),
				network: {
					allowed: ["localhost"],
					fetch: async (input, init) => {
						requests++;
						const response = await fetch(input, init);
						downloaded += (await response.clone().arrayBuffer()).byteLength;
						return response;
					},
				},
			});
		const client = makeClient();
		const run = async (command: string) => {
			const result = await client.exec(command);
			expect(result.exitCode, result.stderr).toBe(0);
			return result;
		};
		await fs.mkdir("/repo", { recursive: true });
		await run("init -b main");
		await run(`remote add origin ${server.url}remote.git`);
		await run("config remote.origin.fetch +refs/heads/main:refs/remotes/origin/main");
		await setConfigValue((await client.findRepo())!, "remote.origin.tagOpt", "--no-tags");
		const preserved =
			"\n# Unrelated configuration\n[credential]\n\thelper = first\n\thelper = second\n";
		await fs.writeFile("/repo/.git/config", (await fs.readFile("/repo/.git/config")) + preserved);
		const configBefore = await fs.readFile("/repo/.git/config");
		const rejected = createGit({
			fs,
			cwd: "/repo",
			hooks: { preFetch: () => ({ reject: true, message: "Denied by hook" }) },
		});
		expect((await rejected.exec("fetch --filter blob:none origin")).exitCode).not.toBe(0);
		expect(await fs.readFile("/repo/.git/config")).toBe(configBefore);
		await run("fetch --depth 1 --filter blob:none --no-tags origin");
		expect(await fs.readFile("/repo/.git/config")).toContain(preserved);
		const repo = await client.findRepo();
		if (!repo) throw new Error("No partial repo");
		const revision = (await resolveRef(repo, "refs/remotes/origin/main"))!;
		const entries = await flattenTree(repo, (await readCommit(repo, revision)).tree);
		const own = entries.filter((entry) => entry.path.startsWith("A/"));
		const other = entries.filter((entry) => entry.path.startsWith("B/"));
		expect(downloaded).toBeLessThan(12 * 1024);
		for (const entry of entries) expect(await repo.objectStore.exists(entry.hash)).toBe(false);
		expect(await resolveRef(repo, "refs/tags/fixture")).toBeNull();
		const refsBefore = await repo.refStore.listRefs();
		const headBefore = await fs.readFile("/repo/.git/FETCH_HEAD");
		const boundaryBefore = await fs.readFile("/repo/.git/shallow");
		expect(
			await fetchObjects(
				repo,
				own.map((entry) => entry.hash),
				{ batchSize: 1 },
			),
		).toEqual({ fetched: 2 });
		for (const entry of own) expect(await repo.objectStore.exists(entry.hash)).toBe(true);
		for (const entry of other) expect(await repo.objectStore.exists(entry.hash)).toBe(false);
		expect(await repo.refStore.listRefs()).toEqual(refsBefore);
		expect(await fs.readFile("/repo/.git/FETCH_HEAD")).toBe(headBefore);
		expect(await fs.readFile("/repo/.git/shallow")).toBe(boundaryBefore);
		const before = requests;
		expect(await fetchObjects(repo, [...own.map((entry) => entry.hash), own[0]!.hash])).toEqual({
			fetched: 0,
		});
		expect(requests).toBe(before);
		await expect(fetchObjects(repo, ["not-a-hash"])).rejects.toThrow("Invalid SHA-1");
		for (const filter of ["tree:0", ""]) {
			await setConfigValue(repo, "remote.origin.partialclonefilter", filter);
			const requestsBefore = requests;
			const invalid = await client.exec("fetch origin");
			expect(invalid.exitCode).not.toBe(0);
			expect(invalid.stderr).toContain("Only the blob:none object filter is supported");
			expect(requests).toBe(requestsBefore);
			await run("fetch --filter blob:none --no-tags origin");
		}
		for (const command of [
			"fetch --filter= origin",
			`clone --filter= --no-checkout ${server.url}remote.git /invalid-clone`,
		]) {
			const invalid = await client.exec(command);
			expect(invalid.exitCode).not.toBe(0);
			expect(invalid.stderr).toContain("Only the blob:none object filter is supported");
		}
		await writeFile(join(source, "A/file.md"), "Incoming file edit.\n");
		await writeFile(join(source, "B/large.bin"), randomBytes(2 * 1024 * 1024));
		git(source, ["add", "."]);
		git(source, ["commit", "-m", "both directories change"]);
		git(source, ["push", "origin", "main"]);
		downloaded = 0;
		const reopened = makeClient();
		const refreshed = await reopened.exec("fetch origin");
		expect(refreshed.exitCode, refreshed.stderr).toBe(0);
		const reopenedRepo = (await reopened.findRepo())!;
		const incomingRevision = (await resolveRef(reopenedRepo, "refs/remotes/origin/main"))!;
		expect(incomingRevision).not.toBe(revision);
		const incomingEntries = await flattenTree(
			reopenedRepo,
			(await readCommit(reopenedRepo, incomingRevision)).tree,
		);
		const incomingOther = incomingEntries.filter((entry) => entry.path.startsWith("B/"));
		for (const entry of incomingOther)
			expect(await reopenedRepo.objectStore.exists(entry.hash)).toBe(false);
		expect(downloaded).toBeLessThan(12 * 1024);
		const incomingOwn = incomingEntries.filter((entry) => entry.path.startsWith("A/"));
		expect(
			await fetchObjects(
				reopenedRepo,
				incomingOwn.map((entry) => entry.hash),
			),
		).toEqual({ fetched: 1 });
		expect(downloaded).toBeLessThan(12 * 1024);
		await reopenedRepo.refStore.writeRef("refs/heads/main", incomingRevision);
		const next = await buildCommit(reopenedRepo, {
			branch: "main",
			files: { "A/file.md": "Edited file.\n", "A/state.bin": randomBytes(1024) },
			message: "partial client edit",
			author: { name: "test", email: "test@example.com" },
		});
		await reopenedRepo.refStore.writeRef("refs/heads/main", next.hash);
		const pushed = await reopened.exec("push origin main:main");
		expect(pushed.exitCode, pushed.stderr).toBe(0);
		for (const entry of incomingOther) {
			expect(await reopenedRepo.objectStore.exists(entry.hash)).toBe(false);
			expect(git(remote, ["rev-parse", "main:" + entry.path])).toBe(entry.hash);
		}
		git(remote, ["fsck", "--full"]);
		for (const command of ["gc", "repack -a", "pull origin main"]) {
			const result = await client.exec(command);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("partial clones");
		}
		expect(new TextDecoder().decode(await readBlob(repo, own[0]!.hash)).length).toBeGreaterThan(0);
		git(remote, ["config", "uploadpack.allowFilter", "false"]);
		const unsupported = await makeClient().exec("fetch --depth 1 --filter blob:none origin");
		expect(unsupported.exitCode).not.toBe(0);
		expect(unsupported.stderr).toContain("filter capability missing");
	} finally {
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
