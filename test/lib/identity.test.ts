import { describe, expect, test } from "bun:test";
import { runScenario } from "../util.ts";
import { BASIC_REPO } from "../fixtures.ts";

describe("GIT_AUTHOR_DATE / GIT_COMMITTER_DATE parsing", () => {
	const baseEnv = {
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@test.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@test.com",
	};

	async function commitAndReadLog(dateStr: string, format: string) {
		const env = {
			...baseEnv,
			GIT_AUTHOR_DATE: dateStr,
			GIT_COMMITTER_DATE: dateStr,
		};
		const { results } = await runScenario(
			["git init", "git add -A", `git commit -m "test"`, `git log -1 --format=${format}`],
			{ files: BASIC_REPO, env },
		);
		expect(results[2].exitCode).toBe(0);
		return results[3].stdout.trim();
	}

	test("pure epoch seconds", async () => {
		expect(await commitAndReadLog("1718454600", "%at")).toBe("1718454600");
		expect(await commitAndReadLog("1718454600", "%ai")).toContain("+0000");
	});

	test("@-prefixed epoch", async () => {
		expect(await commitAndReadLog("@1718454600", "%at")).toBe("1718454600");
	});

	test("git internal format: epoch + timezone", async () => {
		expect(await commitAndReadLog("1718454600 +0200", "%at")).toBe("1718454600");
		expect(await commitAndReadLog("1718454600 +0200", "%ai")).toContain("+0200");
	});

	test("ISO 8601 with compact offset (+0200)", async () => {
		const ai = await commitAndReadLog("2024-06-15T14:30:00+0200", "%ai");
		expect(ai).toMatch(/2024-06-15 14:30:00 \+0200/);

		const at = await commitAndReadLog("2024-06-15T14:30:00+0200", "%at");
		expect(parseInt(at)).toBeGreaterThan(1_000_000_000);
		expect(parseInt(at)).not.toBe(2024);
	});

	test("ISO 8601 with colon offset (+02:00)", async () => {
		const ai = await commitAndReadLog("2024-06-15T14:30:00+02:00", "%ai");
		expect(ai).toMatch(/2024-06-15 14:30:00 \+0200/);
	});

	test("ISO 8601 with Z (UTC)", async () => {
		const ai = await commitAndReadLog("2024-06-15T12:30:00Z", "%ai");
		expect(ai).toMatch(/2024-06-15 12:30:00 \+0000/);
	});

	test("ISO 8601 with negative offset (-0500)", async () => {
		const ai = await commitAndReadLog("2024-06-15T09:30:00-0500", "%ai");
		expect(ai).toContain("-0500");
	});

	test("git internal format with negative tz", async () => {
		const ai = await commitAndReadLog("1718454600 -0430", "%ai");
		expect(ai).toContain("-0430");
	});

	test("does not misparse ISO year as epoch (the original bug)", async () => {
		const at = await commitAndReadLog("2024-06-15T14:30:00+0200", "%at");
		const epoch = parseInt(at);
		expect(epoch).toBeGreaterThan(1_000_000_000);
		expect(epoch).not.toBe(2024);
	});
});
