import { describe, expect, test } from "bun:test";
import { TEST_ENV as ENV } from "./fixtures";
import { createTestBash, pathExists, readFile } from "./util";
import { buildUploadPackResponse, parseUploadPackRequest } from "../src/server/protocol.ts";
import {
	encodePktLine,
	flushPkt,
	concatPktLines,
	parsePktLineStream,
	pktLineText,
} from "../src/lib/transport/pkt-line.ts";

// ── Helpers ──────────────────────────────────────────────────────────

async function setupSourceWithHistory(commitCount: number) {
	const bash = createTestBash({
		files: { "/src/file.txt": "v0\n" },
		env: ENV,
		cwd: "/src",
	});
	await bash.exec("git init");
	await bash.exec("git add .");
	await bash.exec('git commit -m "commit 0"');

	for (let i = 1; i < commitCount; i++) {
		await bash.exec(`echo "v${i}" > file.txt`);
		await bash.exec("git add .");
		await bash.exec(`git commit -m "commit ${i}"`);
	}
	return bash;
}

// ── Shallow clone ───────────────────────────────────────────────────

describe("shallow clone", () => {
	test("--depth 1 creates a shallow repo with .git/shallow", async () => {
		const bash = await setupSourceWithHistory(5);
		const result = await bash.exec("git clone --depth 1 /src /dest", { cwd: "/" });
		expect(result.exitCode).toBe(0);

		const shallowFile = await readFile(bash.fs, "/dest/.git/shallow");
		expect(shallowFile).toBeDefined();
		expect(shallowFile!.trim().length).toBeGreaterThan(0);

		const content = await readFile(bash.fs, "/dest/file.txt");
		expect(content).toBe("v4\n");
	});

	test("--depth 1 clone has only 1 commit in log", async () => {
		const bash = await setupSourceWithHistory(5);
		await bash.exec("git clone --depth 1 /src /dest", { cwd: "/" });

		const log = await bash.exec("git log --oneline", { cwd: "/dest" });
		expect(log.exitCode).toBe(0);
		const lines = log.stdout.trim().split("\n");
		expect(lines.length).toBe(1);
	});

	test("--depth 3 clone has up to 3 commits in log", async () => {
		const bash = await setupSourceWithHistory(5);
		await bash.exec("git clone --depth 3 /src /dest", { cwd: "/" });

		const log = await bash.exec("git log --oneline", { cwd: "/dest" });
		expect(log.exitCode).toBe(0);
		const lines = log.stdout.trim().split("\n");
		expect(lines.length).toBe(3);

		expect(await pathExists(bash.fs, "/dest/.git/shallow")).toBe(true);
	});

	test("clone without --depth gets full history", async () => {
		const bash = await setupSourceWithHistory(5);
		await bash.exec("git clone /src /dest", { cwd: "/" });

		const log = await bash.exec("git log --oneline", { cwd: "/dest" });
		expect(log.exitCode).toBe(0);
		const lines = log.stdout.trim().split("\n");
		expect(lines.length).toBe(5);

		expect(await pathExists(bash.fs, "/dest/.git/shallow")).toBe(false);
	});

	test("shallow clone still checks out working tree correctly", async () => {
		const bash = await setupSourceWithHistory(3);
		await bash.exec("git clone --depth 1 /src /dest", { cwd: "/" });

		expect(await readFile(bash.fs, "/dest/file.txt")).toBe("v2\n");

		const status = await bash.exec("git status", { cwd: "/dest" });
		expect(status.exitCode).toBe(0);
	});
});

// ── Shallow fetch ───────────────────────────────────────────────────

describe("shallow fetch", () => {
	test("fetch --depth on a complete repo creates shallow boundary", async () => {
		const bash = await setupSourceWithHistory(5);
		await bash.exec("git clone /src /dest", { cwd: "/" });

		// Add more commits to source
		await bash.exec('echo "v5" > file.txt && git add . && git commit -m "commit 5"', {
			cwd: "/src",
		});
		await bash.exec('echo "v6" > file.txt && git add . && git commit -m "commit 6"', {
			cwd: "/src",
		});

		const fetchResult = await bash.exec("git fetch --depth 1", { cwd: "/dest" });
		expect(fetchResult.exitCode).toBe(0);
	});

	test("fetch --unshallow on a shallow repo removes .git/shallow", async () => {
		const bash = await setupSourceWithHistory(5);
		await bash.exec("git clone --depth 1 /src /dest", { cwd: "/" });

		expect(await pathExists(bash.fs, "/dest/.git/shallow")).toBe(true);

		const logBefore = await bash.exec("git log --oneline", { cwd: "/dest" });
		expect(logBefore.stdout.trim().split("\n").length).toBe(1);

		const result = await bash.exec("git fetch --unshallow", { cwd: "/dest" });
		expect(result.exitCode).toBe(0);

		expect(await pathExists(bash.fs, "/dest/.git/shallow")).toBe(false);
	});

	test("--unshallow on a complete repo fails", async () => {
		const bash = await setupSourceWithHistory(3);
		await bash.exec("git clone /src /dest", { cwd: "/" });

		const result = await bash.exec("git fetch --unshallow", { cwd: "/dest" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("does not make sense");
	});

	test("--depth and --unshallow together fails", async () => {
		const bash = await setupSourceWithHistory(3);
		await bash.exec("git clone --depth 1 /src /dest", { cwd: "/" });

		const result = await bash.exec("git fetch --depth 2 --unshallow", { cwd: "/dest" });
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("cannot be used together");
	});
});

// ── Shallow pull ────────────────────────────────────────────────────

describe("shallow pull", () => {
	test("pull --depth limits history", async () => {
		const bash = await setupSourceWithHistory(5);
		await bash.exec("git clone /src /dest", { cwd: "/" });

		await bash.exec('echo "v5" > file.txt && git add . && git commit -m "commit 5"', {
			cwd: "/src",
		});

		const result = await bash.exec("git pull --depth 1", { cwd: "/dest" });
		expect(result.exitCode).toBe(0);
	});

	test("pull --unshallow restores full history", async () => {
		const bash = await setupSourceWithHistory(5);
		await bash.exec("git clone --depth 1 /src /dest", { cwd: "/" });

		const result = await bash.exec("git pull --unshallow", { cwd: "/dest" });
		expect(result.exitCode).toBe(0);

		expect(await pathExists(bash.fs, "/dest/.git/shallow")).toBe(false);
	});
});

// ── Protocol parsing ────────────────────────────────────────────────

describe("upload-pack protocol shallow support", () => {
	test("parseUploadPackRequest extracts shallow and deepen lines", () => {
		const lines = concatPktLines(
			encodePktLine("want abc0000000000000000000000000000000000000 shallow side-band-64k\n"),
			encodePktLine("shallow def0000000000000000000000000000000000000\n"),
			encodePktLine("deepen 3\n"),
			flushPkt(),
			encodePktLine("done\n"),
		);

		const request = parseUploadPackRequest(lines);
		expect(request.wants).toEqual(["abc0000000000000000000000000000000000000"]);
		expect(request.capabilities).toContain("shallow");
		expect(request.clientShallows).toEqual(["def0000000000000000000000000000000000000"]);
		expect(request.depth).toBe(3);
	});

	test("parseUploadPackRequest handles no shallow/deepen", () => {
		const lines = concatPktLines(
			encodePktLine("want abc0000000000000000000000000000000000000 side-band-64k\n"),
			flushPkt(),
			encodePktLine("done\n"),
		);

		const request = parseUploadPackRequest(lines);
		expect(request.clientShallows).toEqual([]);
		expect(request.depth).toBeUndefined();
	});

	test("buildUploadPackResponse includes shallow/unshallow lines", () => {
		const packData = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // "PACK"
		const response = buildUploadPackResponse(packData, true, undefined, {
			shallow: ["aaa0000000000000000000000000000000000000"],
			unshallow: ["bbb0000000000000000000000000000000000000"],
		});

		const pktLines = parsePktLineStream(response);
		const texts = pktLines.filter((l) => l.type === "data").map((l) => pktLineText(l));

		expect(texts.some((t) => t.startsWith("shallow "))).toBe(true);
		expect(texts.some((t) => t.startsWith("unshallow "))).toBe(true);
	});
});

// ── Ancillary commands on shallow repos ─────────────────────────────

describe("commands on shallow repos", () => {
	test("git status works on shallow clone", async () => {
		const bash = await setupSourceWithHistory(5);
		await bash.exec("git clone --depth 1 /src /dest", { cwd: "/" });

		const status = await bash.exec("git status", { cwd: "/dest" });
		expect(status.exitCode).toBe(0);
	});

	test("git log works on shallow clone", async () => {
		const bash = await setupSourceWithHistory(5);
		await bash.exec("git clone --depth 2 /src /dest", { cwd: "/" });

		const log = await bash.exec("git log", { cwd: "/dest" });
		expect(log.exitCode).toBe(0);
		expect(log.stdout).toContain("commit");
	});

	test("git diff works on shallow clone", async () => {
		const bash = await setupSourceWithHistory(3);
		await bash.exec("git clone --depth 1 /src /dest", { cwd: "/" });

		await bash.exec('echo "modified" > file.txt', { cwd: "/dest" });
		const diff = await bash.exec("git diff", { cwd: "/dest" });
		expect(diff.exitCode).toBe(0);
	});

	test("git branch -v works on shallow clone", async () => {
		const bash = await setupSourceWithHistory(3);
		await bash.exec("git clone --depth 1 /src /dest", { cwd: "/" });

		const branch = await bash.exec("git branch -v", { cwd: "/dest" });
		expect(branch.exitCode).toBe(0);
	});
});
