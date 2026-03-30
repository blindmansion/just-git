import { describe, expect, test } from "bun:test";
import { parseServerCommit, serializeServerCommit } from "./fileops";

describe("oracle fileops", () => {
	test("round-trips server commit with explicit branch", () => {
		const command = serializeServerCommit(12345, "feature-branch");
		expect(command).toBe("SERVER_COMMIT:12345:feature-branch");
		expect(parseServerCommit(command)).toEqual({
			seed: 12345,
			branch: "feature-branch",
		});
	});

	test("parses legacy main-branch server commit format", () => {
		expect(parseServerCommit("SERVER_COMMIT:67890")).toEqual({
			seed: 67890,
			branch: "main",
		});
	});
});
