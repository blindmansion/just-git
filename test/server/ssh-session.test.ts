import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Server, type ServerChannel } from "ssh2";
import { createCommit, writeBlob, writeTree } from "../../src/repo/helpers.ts";
import { createGitServer } from "../../src/server/handler.ts";
import { MemoryDriver } from "../../src/server/memory-storage.ts";
import { parseGitSshCommand } from "../../src/server/ssh-session.ts";
import type { GitServer, SshChannel } from "../../src/server/types.ts";

const TEST_IDENTITY = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

// ── ssh2 adapter helper ─────────────────────────────────────────────

function wrapSsh2Channel(stream: ServerChannel): SshChannel {
	return {
		readable: new ReadableStream({
			start(controller) {
				stream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
				stream.on("end", () => controller.close());
				stream.on("error", (err: Error) => controller.error(err));
			},
		}),
		writable: new WritableStream({
			write(chunk) {
				stream.write(chunk);
			},
		}),
		writeStderr(data: Uint8Array) {
			stream.stderr.write(Buffer.from(data));
		},
	};
}

// ── parseGitSshCommand unit tests ───────────────────────────────────

describe("parseGitSshCommand", () => {
	test("hyphenated upload-pack with single-quoted path", () => {
		const result = parseGitSshCommand("git-upload-pack '/my-repo.git'");
		expect(result).toEqual({ service: "git-upload-pack", repoPath: "my-repo.git" });
	});

	test("hyphenated receive-pack with single-quoted path", () => {
		const result = parseGitSshCommand("git-receive-pack '/repos/test'");
		expect(result).toEqual({ service: "git-receive-pack", repoPath: "repos/test" });
	});

	test("two-word form", () => {
		const result = parseGitSshCommand("git upload-pack '/repo'");
		expect(result).toEqual({ service: "git-upload-pack", repoPath: "repo" });
	});

	test("unquoted path", () => {
		const result = parseGitSshCommand("git-upload-pack /repo");
		expect(result).toEqual({ service: "git-upload-pack", repoPath: "repo" });
	});

	test("path without leading slash", () => {
		const result = parseGitSshCommand("git-upload-pack 'repo'");
		expect(result).toEqual({ service: "git-upload-pack", repoPath: "repo" });
	});

	test("rejects unknown commands", () => {
		expect(parseGitSshCommand("ls -la")).toBeNull();
		expect(parseGitSshCommand("git status")).toBeNull();
		expect(parseGitSshCommand("")).toBeNull();
	});
});

// ── SSH server integration tests ────────────────────────────────────

describe("SSH session handler", () => {
	let sshServer: Server;
	let sshPort: number;
	let driver: MemoryDriver;
	let server: GitServer;

	beforeAll(async () => {
		driver = new MemoryDriver();
		server = createGitServer({ storage: driver });
		const repo = await server.createRepo("test-repo");

		const readmeBlob = await writeBlob(repo, "# SSH Test");
		const indexBlob = await writeBlob(repo, "export const x = 1;");
		const srcTree = await writeTree(repo, [{ name: "index.ts", hash: indexBlob }]);
		const rootTree = await writeTree(repo, [
			{ name: "README.md", hash: readmeBlob },
			{ name: "src", hash: srcTree, mode: "40000" },
		]);
		const commitHash = await createCommit(repo, {
			tree: rootTree,
			parents: [],
			author: TEST_IDENTITY,
			committer: TEST_IDENTITY,
			message: "initial\n",
		});
		await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commitHash });
		await repo.refStore.writeRef("refs/tags/v1.0", { type: "direct", hash: commitHash });

		const hostKey = readFileSync("/tmp/just-git-test-host-key");

		sshPort = await new Promise<number>((resolve, reject) => {
			sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
				client.on("authentication", (ctx) => ctx.accept());
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (accept, _reject, info) => {
						const stream = accept();
						const channel = wrapSsh2Channel(stream);
						server
							.handleSession(info.command, channel, {
								username: "test-user",
							})
							.then((code) => {
								stream.exit(code);
								stream.close();
							});
					});
				});
			});

			sshServer.listen(0, "127.0.0.1", function (this: Server) {
				const addr = this.address();
				if (typeof addr === "object" && addr) {
					resolve(addr.port);
				} else {
					reject(new Error("Failed to get SSH server port"));
				}
			});
		});
	});

	afterAll(() => {
		sshServer?.close();
	});

	test("handleSession processes upload-pack", async () => {
		const testServer = createGitServer({ storage: driver });

		const repo = (await testServer.repo("test-repo"))!;
		const { refs: allRefs } = await import("../../src/server/operations.ts").then((m) =>
			m.collectRefs(repo),
		);
		const headRef = allRefs.find((r) => r.name === "HEAD");
		expect(headRef).toBeTruthy();

		const wantLine = `want ${headRef!.hash}\n`;
		const wantPkt = encodePktLine(wantLine);
		const flushPkt = new Uint8Array([0x30, 0x30, 0x30, 0x30]);
		const donePkt = encodePktLine("done\n");

		const requestBytes = concatBytes(wantPkt, flushPkt, donePkt);

		const responseChunks: Uint8Array[] = [];
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(controller) {
					controller.enqueue(requestBytes);
					controller.close();
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					responseChunks.push(chunk);
				},
			}),
		};

		const exitCode = await testServer.handleSession("git-upload-pack '/test-repo'", channel);

		expect(exitCode).toBe(0);
		expect(responseChunks.length).toBeGreaterThan(0);

		const totalResponse = concatBytes(...responseChunks);
		const text = new TextDecoder().decode(totalResponse);
		expect(text).toContain("HEAD");
	});

	test("handleSession rejects unknown repo", async () => {
		const testServer = createGitServer({
			storage: new MemoryDriver(),
			resolve: () => null,
			onError: false,
		});

		let stderrOutput = "";
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			writable: new WritableStream(),
			writeStderr(data) {
				stderrOutput += new TextDecoder().decode(data);
			},
		};

		const exitCode = await testServer.handleSession("git-upload-pack '/no-such-repo'", channel);

		expect(exitCode).toBe(128);
		expect(stderrOutput).toContain("does not appear to be a git repository");
	});

	test("handleSession rejects unknown command", async () => {
		const testServer = createGitServer({
			storage: driver,
			onError: false,
		});

		let stderrOutput = "";
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			writable: new WritableStream(),
			writeStderr(data) {
				stderrOutput += new TextDecoder().decode(data);
			},
		};

		const exitCode = await testServer.handleSession("ls -la", channel);

		expect(exitCode).toBe(128);
		expect(stderrOutput).toContain("unrecognized command");
	});

	test("handleSession rejects when advertiseRefs returns rejection", async () => {
		const testServer = createGitServer({
			storage: driver,
			hooks: {
				advertiseRefs: async () => {
					return { reject: true, message: "no access" };
				},
			},
			onError: false,
		});

		let stderrOutput = "";
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			writable: new WritableStream(),
			writeStderr(data) {
				stderrOutput += new TextDecoder().decode(data);
			},
		};

		const exitCode = await testServer.handleSession("git-upload-pack '/test-repo'", channel);

		expect(exitCode).toBe(128);
		expect(stderrOutput).toContain("no access");
	});

	test("handleSession handles empty upload-pack (ls-remote)", async () => {
		const testServer = createGitServer({ storage: driver });

		const responseChunks: Uint8Array[] = [];
		const channel: SshChannel = {
			readable: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					responseChunks.push(chunk);
				},
			}),
		};

		const exitCode = await testServer.handleSession("git-upload-pack '/test-repo'", channel);

		expect(exitCode).toBe(0);
		const text = new TextDecoder().decode(concatBytes(...responseChunks));
		expect(text).toContain("HEAD");
	});

	test("real git clone over SSH", async () => {
		const workDir = await createSshTestDir();
		const env = sshTestEnv(sshPort, workDir);

		const clone = Bun.spawn(["git", "clone", `ssh://test@127.0.0.1/test-repo`, "cloned"], {
			cwd: workDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const cloneResult = await collectProc(clone);
		expect(cloneResult.exitCode).toBe(0);

		const { readFileSync: readFs } = await import("node:fs");
		const { join } = await import("node:path");
		expect(readFs(join(workDir, "cloned", "README.md"), "utf8")).toBe("# SSH Test");
		expect(readFs(join(workDir, "cloned", "src", "index.ts"), "utf8")).toBe("export const x = 1;");

		await cleanupDir(workDir);
	});

	test("real git clone + push over SSH", async () => {
		const workDir = await createSshTestDir();
		const env = sshTestEnv(sshPort, workDir);
		const { join } = await import("node:path");
		const { readFileSync: readFs, writeFileSync: writeFs } = await import("node:fs");

		const clone = Bun.spawn(["git", "clone", `ssh://test@127.0.0.1/test-repo`, "work"], {
			cwd: workDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect((await collectProc(clone)).exitCode).toBe(0);

		const repoDir = join(workDir, "work");

		writeFs(join(repoDir, "new-file.txt"), "pushed via SSH");
		const add = Bun.spawn(["git", "add", "."], {
			cwd: repoDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect((await collectProc(add)).exitCode).toBe(0);

		const commitEnv = {
			...env,
			GIT_AUTHOR_NAME: "SSH Test",
			GIT_AUTHOR_EMAIL: "ssh@test.com",
			GIT_COMMITTER_NAME: "SSH Test",
			GIT_COMMITTER_EMAIL: "ssh@test.com",
		};
		const commit = Bun.spawn(["git", "commit", "-m", "push test"], {
			cwd: repoDir,
			env: commitEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect((await collectProc(commit)).exitCode).toBe(0);

		const push = Bun.spawn(["git", "push", "origin", "main"], {
			cwd: repoDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const pushResult = await collectProc(push);
		expect(pushResult.exitCode).toBe(0);

		const repo = (await server.repo("test-repo"))!;
		const mainRef = await repo.refStore.readRef("refs/heads/main");
		expect(mainRef).toBeTruthy();

		const clone2 = Bun.spawn(["git", "clone", `ssh://test@127.0.0.1/test-repo`, "verify"], {
			cwd: workDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect((await collectProc(clone2)).exitCode).toBe(0);
		expect(readFs(join(workDir, "verify", "new-file.txt"), "utf8")).toBe("pushed via SSH");

		await cleanupDir(workDir);
	});
});

// ── Helpers ─────────────────────────────────────────────────────────

function encodePktLine(data: string): Uint8Array {
	const payload = new TextEncoder().encode(data);
	const totalLen = 4 + payload.byteLength;
	const hex = totalLen.toString(16).padStart(4, "0");
	const result = new Uint8Array(totalLen);
	result[0] = hex.charCodeAt(0);
	result[1] = hex.charCodeAt(1);
	result[2] = hex.charCodeAt(2);
	result[3] = hex.charCodeAt(3);
	result.set(payload, 4);
	return result;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const a of arrays) len += a.byteLength;
	const result = new Uint8Array(len);
	let off = 0;
	for (const a of arrays) {
		result.set(a, off);
		off += a.byteLength;
	}
	return result;
}

async function collectProc(proc: ReturnType<typeof Bun.spawn>) {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function createSshTestDir() {
	const { mkdtemp } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	return mkdtemp(join(tmpdir(), "just-git-ssh-test-"));
}

async function cleanupDir(dir: string) {
	const { rm } = await import("node:fs/promises");
	await rm(dir, { recursive: true, force: true });
}

function sshTestEnv(port: number, home: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_PROTOCOL_VERSION: "1",
		GIT_SSH_COMMAND: `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${port}`,
	};
}
