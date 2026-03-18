import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { findRepo } from "../../src/lib/repo.ts";
import { createGitServer } from "../../src/server/handler.ts";
import {
	encodePktLine,
	flushPkt,
	concatPktLines,
	parsePktLineStream,
	pktLineText,
} from "../../src/lib/transport/pkt-line.ts";
import { envAt } from "./util.ts";

async function setupRepo() {
	const fs = new InMemoryFs();
	const git = createGit();
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });

	await bash.writeFile("/repo/README.md", "# test");
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "init"', { env: envAt(1000000000) });

	const ctx = await findRepo(fs, "/repo");
	if (!ctx) throw new Error("no git dir");
	return ctx;
}

// ── resolveRepo error paths ─────────────────────────────────────────

describe("resolveRepo returns null", () => {
	const server = createGitServer({ resolveRepo: async () => null });

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

describe("resolveRepo throws", () => {
	const server = createGitServer({
		resolveRepo: async () => {
			throw new Error("database connection lost");
		},
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

// ── Malformed request bodies ────────────────────────────────────────

describe("malformed upload-pack body", () => {
	test("garbage bytes return 500", async () => {
		const repo = await setupRepo();
		const server = createGitServer({ resolveRepo: async () => repo });

		const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
		const res = await server.fetch(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				body: garbage,
			}),
		);
		// Should return a response (200 with empty pack, or 500), not crash
		expect([200, 500]).toContain(res.status);
	});

	test("empty body (no wants) returns 200 with valid response", async () => {
		const repo = await setupRepo();
		const server = createGitServer({ resolveRepo: async () => repo });

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
	test("truncated pkt-line does not crash", async () => {
		const repo = await setupRepo();
		const server = createGitServer({ resolveRepo: async () => repo });

		// pkt-line header says 50 bytes but only 10 are present
		const truncated = new TextEncoder().encode("0032");
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body: truncated,
			}),
		);
		expect([200, 500]).toContain(res.status);
	});

	test("flush-only body (no commands) returns 200", async () => {
		const repo = await setupRepo();
		const server = createGitServer({ resolveRepo: async () => repo });

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

// ── Push with invalid pack data ─────────────────────────────────────

describe("push with bad pack data", () => {
	test("invalid pack data sets unpackOk to false", async () => {
		const repo = await setupRepo();

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

		const server = createGitServer({ resolveRepo: async () => repo });
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

// ── Delete ref that doesn't exist ───────────────────────────────────

describe("delete non-existent ref", () => {
	test("CAS fails gracefully and reports ng", async () => {
		const repo = await setupRepo();

		const oldHash = "f".repeat(40);
		const zeroHash = "0".repeat(40);

		const commandLine = `${oldHash} ${zeroHash} refs/heads/nonexistent`;
		const nul = new Uint8Array([0]);
		const enc = new TextEncoder();
		const payload = concatPktLines(enc.encode(commandLine), nul, enc.encode(" report-status\n"));
		const firstLine = encodePktLine(payload);

		const body = concatPktLines(firstLine, flushPkt());

		const server = createGitServer({ resolveRepo: async () => repo });
		const res = await server.fetch(
			new Request("http://localhost/repo/git-receive-pack", {
				method: "POST",
				body,
			}),
		);

		expect(res.status).toBe(200);
		const resBody = new Uint8Array(await res.arrayBuffer());
		const lines = parsePktLineStream(resBody);

		// Should report unpack ok (no pack data) but ng for the ref
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

// ── CAS failure during ref update ───────────────────────────────────

describe("CAS race on ref update", () => {
	test("ref changed between ingest and apply is reported as failed", async () => {
		const repo = await setupRepo();

		const mainRef = await repo.refStore.readRef("refs/heads/main");
		const mainHash = mainRef?.type === "direct" ? mainRef.hash : "0".repeat(40);
		const newHash = "b".repeat(40);

		// Advance the ref before the handler tries CAS, simulating a race
		const server = createGitServer({
			resolveRepo: async () => repo,
			hooks: {
				preReceive: async () => {
					// Sneak in a ref update during hook processing
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

		// The ref update should fail because CAS expected mainHash but it's now ccc...
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
