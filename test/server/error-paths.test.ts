import { describe, expect, test } from "bun:test";
import { createCommit, writeBlob, writeTree } from "../../src/repo/writing.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import { createStorageAdapter } from "../../src/server/storage.ts";
import {
	encodePktLine,
	flushPkt,
	concatPktLines,
	parsePktLineStream,
	pktLineText,
} from "../../src/lib/transport/pkt-line.ts";
import { sha1 } from "../../src/lib/sha1.ts";

const TEST_IDENTITY = {
	name: "Test",
	email: "test@test.com",
	timestamp: 1000000000,
	timezone: "+0000",
};

async function setupRepo() {
	const driver = new MemoryStorage();
	const storage = createStorageAdapter(driver);
	const repo = await storage.createRepo("repo");
	const blob = await writeBlob(repo, "# test");
	const tree = await writeTree(repo, [{ name: "README.md", hash: blob }]);
	const commit = await createCommit(repo, {
		tree,
		parents: [],
		author: TEST_IDENTITY,
		committer: TEST_IDENTITY,
		message: "init\n",
	});
	await repo.refStore.writeRef("refs/heads/main", { type: "direct", hash: commit });
	return { repo, driver };
}

describe("createServer config validation", () => {
	test("missing storage throws descriptive error", () => {
		expect(() => createServer({ resolve: async () => "repo" } as any)).toThrow(
			"config.storage is required",
		);
	});

	test("passing empty config throws descriptive error", () => {
		expect(() => createServer({} as any)).toThrow("config.storage is required");
	});

	test("passing null config throws descriptive error", () => {
		expect(() => createServer(null as any)).toThrow("config.storage is required");
	});
});

describe("resolve returns null", () => {
	const server = createServer({ storage: new MemoryStorage(), resolve: () => null });

	test("info/refs returns 404", async () => {
		const res = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(404);
	});

	test("git-upload-pack returns 404", async () => {
		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: flushPkt(),
			}),
		);
		expect(res.status).toBe(404);
	});

	test("git-receive-pack returns 404", async () => {
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body: flushPkt(),
			}),
		);
		expect(res.status).toBe(404);
	});
});

describe("resolve throws", () => {
	const server = createServer({
		storage: new MemoryStorage(),
		resolve: async () => {
			throw new Error("database connection lost");
		},
		onError: false,
	});

	test("info/refs returns 500", async () => {
		const res = await server.fetch(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);
		expect(res.status).toBe(500);
	});

	test("git-upload-pack returns 500", async () => {
		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: new Uint8Array(0),
			}),
		);
		expect(res.status).toBe(500);
	});

	test("git-receive-pack returns 500", async () => {
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body: new Uint8Array(0),
			}),
		);
		expect(res.status).toBe(500);
	});
});

describe("malformed upload-pack body", () => {
	test("garbage bytes return 500", async () => {
		const { driver } = await setupRepo();
		const server = createServer({
			storage: driver,
			onError: false,
		});

		const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: garbage,
			}),
		);
		expect(res.status).toBe(500);
	});

	test("empty body (no wants) returns 200 with valid response", async () => {
		const { driver } = await setupRepo();
		const server = createServer({ storage: driver });

		const emptyBody = concatPktLines(flushPkt(), encodePktLine("done\n"));
		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: emptyBody,
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-result");
	});
});

describe("malformed receive-pack body", () => {
	test("garbage bytes return 400", async () => {
		const { driver } = await setupRepo();
		const server = createServer({ storage: driver });

		const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body: garbage,
			}),
		);
		expect(res.status).toBe(400);
	});

	test("empty body returns 400", async () => {
		const { driver } = await setupRepo();
		const server = createServer({ storage: driver });

		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body: new Uint8Array(0),
			}),
		);
		expect(res.status).toBe(400);
	});

	test("truncated pkt-line returns 400", async () => {
		const { driver } = await setupRepo();
		const server = createServer({ storage: driver });

		const truncated = new TextEncoder().encode("0032");
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body: truncated,
			}),
		);
		expect(res.status).toBe(400);
	});

	test("flush-only body (no commands) returns 200", async () => {
		const { driver } = await setupRepo();
		const server = createServer({ storage: driver });

		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body: flushPkt(),
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/x-git-receive-pack-result");
	});
});

function buildPushBody(
	commands: Array<{ oldHash: string; newHash: string; refName: string }>,
	packData: Uint8Array = new Uint8Array(0),
) {
	const enc = new TextEncoder();
	const nul = new Uint8Array([0]);
	const lines: Uint8Array[] = [];
	for (let i = 0; i < commands.length; i++) {
		const cmd = commands[i]!;
		const commandLine = `${cmd.oldHash} ${cmd.newHash} ${cmd.refName}`;
		if (i === 0) {
			const payload = concatPktLines(enc.encode(commandLine), nul, enc.encode(" report-status\n"));
			lines.push(encodePktLine(payload));
		} else {
			lines.push(encodePktLine(enc.encode(commandLine + "\n")));
		}
	}
	return concatPktLines(...lines, flushPkt(), packData);
}

async function buildEmptyPack(): Promise<Uint8Array> {
	const header = new Uint8Array(12);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x5041434b); // "PACK"
	view.setUint32(4, 2); // version 2
	view.setUint32(8, 0); // 0 objects
	const checksum = await sha1(header);
	const checksumBytes = new Uint8Array(20);
	for (let i = 0; i < 20; i++) {
		checksumBytes[i] = parseInt(checksum.slice(i * 2, i * 2 + 2), 16);
	}
	const result = new Uint8Array(32);
	result.set(header, 0);
	result.set(checksumBytes, 12);
	return result;
}

function buildCorruptPack(): Uint8Array {
	const pack = new Uint8Array(32);
	const view = new DataView(pack.buffer);
	view.setUint32(0, 0x42414421); // "BAD!"
	view.setUint32(4, 2);
	view.setUint32(8, 0); // 0 objects — triggers the early-return bug
	return pack;
}

describe("push with bad pack data", () => {
	test("invalid pack data sets unpackOk to false", async () => {
		const { repo, driver } = await setupRepo();

		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef?.type === "direct" ? mainRef.hash : "0".repeat(40);
		const newHash = "a".repeat(40);

		const commandLine = `${mainHash} ${newHash} refs/heads/main`;
		const nul = new Uint8Array([0]);
		const enc = new TextEncoder();
		const payload = concatPktLines(enc.encode(commandLine), nul, enc.encode(" report-status\n"));
		const firstLine = encodePktLine(payload);

		const badPack = new Uint8Array([0xba, 0xad, 0xf0, 0x0d]);
		const body = concatPktLines(firstLine, flushPkt(), badPack);

		const server = createServer({ storage: driver });
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body,
			}),
		);

		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const text = new TextDecoder().decode(resBody);
		expect(text).toContain("unpack");
	});

	test("corrupt pack with bad signature and zero objects reports unpack error", async () => {
		const { driver } = await setupRepo();
		const server = createServer({ storage: driver });
		const zeroHash = "0".repeat(40);
		const fakeHash = "a".repeat(40);

		const body = buildPushBody(
			[{ oldHash: zeroHash, newHash: fakeHash, refName: "refs/heads/hack" }],
			buildCorruptPack(),
		);

		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", { method: "POST", body }),
		);
		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(resBody);
		expect(pktLineText(lines[0]!)).toBe("unpack error");
	});

	test("corrupt pack does not create dangling ref", async () => {
		const { repo, driver } = await setupRepo();
		const server = createServer({ storage: driver });
		const zeroHash = "0".repeat(40);
		const fakeHash = "a".repeat(40);

		const body = buildPushBody(
			[{ oldHash: zeroHash, newHash: fakeHash, refName: "refs/heads/hack" }],
			buildCorruptPack(),
		);

		await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", { method: "POST", body }),
		);

		const ref = await repo.refStore.readRef("refs/heads/hack");
		expect(ref).toBeNull();
	});

	test("valid empty pack with zero objects does not fail", async () => {
		const { repo, driver } = await setupRepo();
		const server = createServer({ storage: driver });
		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef?.type === "direct" ? mainRef.hash : "0".repeat(40);
		const zeroHash = "0".repeat(40);

		const body = buildPushBody(
			[{ oldHash: zeroHash, newHash: mainHash, refName: "refs/heads/new-branch" }],
			await buildEmptyPack(),
		);

		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", { method: "POST", body }),
		);
		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(resBody);
		expect(pktLineText(lines[0]!)).toBe("unpack ok");

		let foundOk = false;
		for (const line of lines) {
			if (pktLineText(line).startsWith("ok refs/heads/new-branch")) foundOk = true;
		}
		expect(foundOk).toBe(true);
	});
});

describe("push with non-existent object hash", () => {
	test("ref create with missing newHash is rejected", async () => {
		const { repo, driver } = await setupRepo();
		const server = createServer({ storage: driver });
		const zeroHash = "0".repeat(40);
		const fakeHash = "a".repeat(40);

		const body = buildPushBody(
			[{ oldHash: zeroHash, newHash: fakeHash, refName: "refs/heads/phantom" }],
			await buildEmptyPack(),
		);

		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", { method: "POST", body }),
		);
		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(resBody);

		expect(pktLineText(lines[0]!)).toBe("unpack ok");

		let foundNg = false;
		for (const line of lines) {
			const text = pktLineText(line);
			if (text.startsWith("ng refs/heads/phantom")) {
				foundNg = true;
				expect(text).toContain("missing objects");
			}
		}
		expect(foundNg).toBe(true);

		const ref = await repo.refStore.readRef("refs/heads/phantom");
		expect(ref).toBeNull();
	});

	test("ref update with missing newHash is rejected", async () => {
		const { repo, driver } = await setupRepo();
		const server = createServer({ storage: driver });
		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef?.type === "direct" ? mainRef.hash : "0".repeat(40);
		const fakeHash = "b".repeat(40);

		const body = buildPushBody(
			[{ oldHash: mainHash, newHash: fakeHash, refName: "refs/heads/main" }],
			await buildEmptyPack(),
		);

		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", { method: "POST", body }),
		);
		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(resBody);

		expect(pktLineText(lines[0]!)).toBe("unpack ok");

		let foundNg = false;
		for (const line of lines) {
			const text = pktLineText(line);
			if (text.startsWith("ng refs/heads/main")) {
				foundNg = true;
				expect(text).toContain("missing objects");
			}
		}
		expect(foundNg).toBe(true);

		const ref = await repo.refStore.readRef("refs/heads/main");
		expect(ref?.type === "direct" ? ref.hash : null).toBe(mainHash);
	});

	test("ref delete with zero newHash is not blocked by existence check", async () => {
		const { repo, driver } = await setupRepo();
		const server = createServer({ storage: driver });
		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef?.type === "direct" ? mainRef.hash : "0".repeat(40);
		const zeroHash = "0".repeat(40);

		const body = buildPushBody(
			[{ oldHash: mainHash, newHash: zeroHash, refName: "refs/heads/main" }],
			await buildEmptyPack(),
		);

		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", { method: "POST", body }),
		);
		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(resBody);

		expect(pktLineText(lines[0]!)).toBe("unpack ok");

		let foundOk = false;
		for (const line of lines) {
			if (pktLineText(line).startsWith("ok refs/heads/main")) foundOk = true;
		}
		expect(foundOk).toBe(true);
	});
});

describe("delete non-existent ref", () => {
	test("CAS fails gracefully and reports ng", async () => {
		const { driver } = await setupRepo();

		const oldHash = "f".repeat(40);
		const zeroHash = "0".repeat(40);

		const commandLine = `${oldHash} ${zeroHash} refs/heads/nonexistent`;
		const nul = new Uint8Array([0]);
		const enc = new TextEncoder();
		const payload = concatPktLines(enc.encode(commandLine), nul, enc.encode(" report-status\n"));
		const firstLine = encodePktLine(payload);

		const body = concatPktLines(firstLine, flushPkt());

		const server = createServer({ storage: driver });
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body,
			}),
		);

		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(resBody);

		expect(pktLineText(lines[0]!)).toBe("unpack ok");
		let foundNg = false;
		for (const line of lines) {
			const text = pktLineText(line);
			if (text.startsWith("ng refs/heads/nonexistent")) {
				foundNg = true;
			}
		}
		expect(foundNg).toBe(true);
	});
});

describe("push with invalid ref names", () => {
	const BAD_REFS = [
		["refs/heads/has~tilde", "contains ~"],
		["refs/heads/has^caret", "contains ^"],
		["refs/heads/has..double", "contains .."],
		["refs/heads/.hidden", "component starts with ."],
		["refs/heads/test.lock", "ends with .lock"],
		["refs/heads/has:colon", "contains :"],
		["refs/heads/@{bad}", "contains @{"],
		["refs/heads/has[bracket", "contains ["],
	];

	for (const [refName, reason] of BAD_REFS) {
		test(`rejects ${JSON.stringify(refName)} (${reason})`, async () => {
			const { driver } = await setupRepo();

			const zeroHash = "0".repeat(40);
			const newHash = "a".repeat(40);

			const commandLine = `${zeroHash} ${newHash} ${refName}`;
			const nul = new Uint8Array([0]);
			const enc = new TextEncoder();
			const payload = concatPktLines(enc.encode(commandLine), nul, enc.encode(" report-status\n"));
			const firstLine = encodePktLine(payload);

			const body = concatPktLines(firstLine, flushPkt());

			const server = createServer({ storage: driver });
			const res = await server.fetch(
				new Request("http://localhost/repo/git-receive-pack", {
					method: "POST",
					body,
				}),
			);

			expect(res.status).toBe(200);
			const resBody = new Uint8Array(await res.arrayBuffer());
			const lines = parsePktLineStream(resBody);

			let foundNg = false;
			for (const line of lines) {
				const text = pktLineText(line);
				if (text.startsWith(`ng ${refName}`)) {
					foundNg = true;
					expect(text).toContain("invalid refname");
				}
			}
			expect(foundNg).toBe(true);
		});
	}

	test("valid ref names are still accepted", async () => {
		const { repo, driver } = await setupRepo();

		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef?.type === "direct" ? mainRef.hash : "0".repeat(40);
		const zeroHash = "0".repeat(40);

		const commandLine = `${zeroHash} ${mainHash} refs/heads/valid-branch`;
		const nul = new Uint8Array([0]);
		const enc = new TextEncoder();
		const payload = concatPktLines(enc.encode(commandLine), nul, enc.encode(" report-status\n"));
		const firstLine = encodePktLine(payload);
		const body = concatPktLines(firstLine, flushPkt());

		const server = createServer({ storage: driver });
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body,
			}),
		);

		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(resBody);

		let foundOk = false;
		for (const line of lines) {
			const text = pktLineText(line);
			if (text.startsWith("ok refs/heads/valid-branch")) {
				foundOk = true;
			}
		}
		expect(foundOk).toBe(true);
	});
});

describe("onError callback", () => {
	test("default onError logs message without stack trace", async () => {
		const calls: unknown[][] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => calls.push(args);

		try {
			const server = createServer({
				storage: new MemoryStorage(),
				resolve: async () => {
					throw new Error("db connection lost");
				},
			});
			const res = await server.fetch(
				new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
			);
			expect(res.status).toBe(500);
			expect(calls.length).toBe(1);

			const logged = String(calls[0]![0]);
			expect(logged).toContain("db connection lost");
			expect(logged).not.toContain("\n");
		} finally {
			console.error = origError;
		}
	});

	test("custom onError receives error and session", async () => {
		let captured: { err: unknown; session: unknown } | null = null;
		const server = createServer({
			storage: new MemoryStorage(),
			resolve: async () => {
				throw new Error("custom error");
			},
			onError: (err, session) => {
				captured = { err, session };
			},
		});

		const req = new Request("http://localhost/repo/info/refs?service=git-upload-pack");
		await server.fetch(req);

		expect(captured).not.toBeNull();
		expect(captured!.err).toBeInstanceOf(Error);
		expect((captured!.err as Error).message).toBe("custom error");
		const session = captured!.session as { transport: string; request: Request };
		expect(session.transport).toBe("http");
		expect(session.request.url).toBe(req.url);
	});

	test("onError: false suppresses all logging", async () => {
		const calls: unknown[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => calls.push(args);

		try {
			const server = createServer({
				storage: new MemoryStorage(),
				resolve: async () => {
					throw new Error("should not appear");
				},
				onError: false,
			});
			const res = await server.fetch(
				new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
			);
			expect(res.status).toBe(500);
			expect(calls.length).toBe(0);
		} finally {
			console.error = origError;
		}
	});
});

describe("CAS race on ref update", () => {
	test("ref changed between ingest and apply is reported as failed", async () => {
		const { repo, driver } = await setupRepo();

		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef?.type === "direct" ? mainRef.hash : "0".repeat(40);
		const newHash = "b".repeat(40);

		const server = createServer({
			storage: driver,
			hooks: {
				preReceive: async () => {
					await repo.refStore.writeRef("refs/heads/main", {
						type: "direct",
						hash: "c".repeat(40),
					});
				},
			},
		});

		const commandLine = `${mainHash} ${newHash} refs/heads/main`;
		const nul = new Uint8Array([0]);
		const enc = new TextEncoder();
		const payload = concatPktLines(enc.encode(commandLine), nul, enc.encode(" report-status\n"));
		const firstLine = encodePktLine(payload);

		const body = concatPktLines(firstLine, flushPkt());
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body,
			}),
		);

		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(resBody);

		let foundNg = false;
		for (const line of lines) {
			const text = pktLineText(line);
			if (text.startsWith("ng refs/heads/main")) {
				foundNg = true;
			}
		}
		expect(foundNg).toBe(true);
	});
});
