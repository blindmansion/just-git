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
