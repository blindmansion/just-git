import { describe, expect, test } from "bun:test";
import {
	checkRefFormat,
	isValidBranchName,
	isValidTagName,
	RefFormatFlag,
} from "../../src/lib/refs.ts";
import { runScenario } from "../util.ts";
import { TEST_ENV } from "../fixtures.ts";

describe("checkRefFormat", () => {
	describe("rejects invalid full refnames", () => {
		const invalid: [string, string][] = [
			["refs/heads/..invalid", "component starts with .."],
			["refs/heads/.hidden", "component starts with ."],
			["refs/heads/has..double", "contains .."],
			["refs/heads/has.lock", "component ends with .lock"],
			["refs/heads/has.lock.lock", "component ends with .lock.lock"],
			["refs/heads/has//double", "contains //"],
			["refs/heads/@{invalid}", "contains @{"],
			["refs/heads/has~tilde", "contains ~"],
			["refs/heads/has^caret", "contains ^"],
			["refs/heads/has:colon", "contains :"],
			["refs/heads/has*star", "contains *"],
			["refs/heads/has?question", "contains ?"],
			["refs/heads/has[bracket", "contains ["],
			["refs/heads/has\\backslash", "contains \\"],
			["refs/heads/has space", "contains space"],
			["refs/heads/has\ttab", "contains tab"],
			["refs/heads/has\x01control", "contains control char"],
			["refs/heads/has\x7fDEL", "contains DEL"],
			["refs/heads/trail.", "ends with ."],
			["refs/heads/", "trailing /"],
			["/refs/heads/main", "leading /"],
			["@", "single @"],
			["", "empty string"],
		];

		for (const [name, reason] of invalid) {
			test(`${JSON.stringify(name)} (${reason})`, () => {
				expect(checkRefFormat(name)).toBe(false);
			});
		}
	});

	describe("accepts valid full refnames", () => {
		const valid = [
			"refs/heads/main",
			"refs/heads/feature/branch",
			"refs/tags/v1.0",
			"refs/remotes/origin/main",
			"refs/heads/has-dash",
			"refs/heads/has_underscore",
			"refs/heads/has.dot",
			"refs/heads/UPPERCASE",
			"refs/heads/has@sign",
			"refs/heads/123",
		];

		for (const name of valid) {
			test(JSON.stringify(name), () => {
				expect(checkRefFormat(name)).toBe(true);
			});
		}
	});

	test("requires at least two components by default", () => {
		expect(checkRefFormat("main")).toBe(false);
		expect(checkRefFormat("refs/heads/main")).toBe(true);
	});

	test("ALLOW_ONELEVEL accepts single-component refs", () => {
		expect(checkRefFormat("HEAD", RefFormatFlag.ALLOW_ONELEVEL)).toBe(true);
		expect(checkRefFormat("main", RefFormatFlag.ALLOW_ONELEVEL)).toBe(true);
	});

	test("REFSPEC_PATTERN allows a single *", () => {
		expect(checkRefFormat("refs/heads/*", RefFormatFlag.REFSPEC_PATTERN)).toBe(true);
		expect(checkRefFormat("refs/heads/*/foo", RefFormatFlag.REFSPEC_PATTERN)).toBe(true);
	});

	test("REFSPEC_PATTERN rejects multiple *", () => {
		expect(checkRefFormat("refs/heads/*/*", RefFormatFlag.REFSPEC_PATTERN)).toBe(false);
		expect(checkRefFormat("refs/*/heads/*", RefFormatFlag.REFSPEC_PATTERN)).toBe(false);
	});
});

describe("isValidBranchName", () => {
	test("rejects empty", () => expect(isValidBranchName("")).toBe(false));
	test("rejects leading dash", () => expect(isValidBranchName("-foo")).toBe(false));
	test("rejects ..", () => expect(isValidBranchName("has..dots")).toBe(false));
	test("rejects ~", () => expect(isValidBranchName("has~1")).toBe(false));
	test("rejects ^", () => expect(isValidBranchName("has^2")).toBe(false));
	test("rejects :", () => expect(isValidBranchName("has:colon")).toBe(false));
	test("rejects space", () => expect(isValidBranchName("has space")).toBe(false));
	test("rejects .lock", () => expect(isValidBranchName("test.lock")).toBe(false));
	test("rejects @{", () => expect(isValidBranchName("@{bad}")).toBe(false));
	test("rejects leading .", () => expect(isValidBranchName(".hidden")).toBe(false));
	test("accepts normal names", () => expect(isValidBranchName("feature")).toBe(true));
	test("accepts slashes", () => expect(isValidBranchName("feature/sub")).toBe(true));
	test("accepts dots", () => expect(isValidBranchName("v1.0")).toBe(true));
});

describe("isValidTagName", () => {
	test("rejects ~", () => expect(isValidTagName("has~1")).toBe(false));
	test("rejects ^", () => expect(isValidTagName("has^2")).toBe(false));
	test("accepts normal names", () => expect(isValidTagName("v1.0.0")).toBe(true));
});

describe("command integration", () => {
	const BAD_NAMES = [
		"..invalid",
		".hidden",
		"has..double",
		"has.lock",
		"has//double",
		"@{invalid}",
		"has~tilde",
		"has^caret",
		"has:colon",
		"has*star",
		"has?question",
		"has[bracket",
	];

	const SETUP = ["git init", "git add .", 'git commit -m "initial"'];

	describe("git branch rejects invalid names", () => {
		for (const name of BAD_NAMES) {
			test(`rejects ${JSON.stringify(name)}`, async () => {
				const { results } = await runScenario([...SETUP, `git branch '${name}'`], {
					files: { "/repo/README.md": "# Hello" },
					env: TEST_ENV,
				});
				const r = results[results.length - 1]!;
				expect(r.exitCode).not.toBe(0);
				expect(r.stderr).toContain("not a valid branch name");
			});
		}
	});

	describe("git tag rejects invalid names", () => {
		for (const name of BAD_NAMES) {
			test(`rejects ${JSON.stringify(name)}`, async () => {
				const { results } = await runScenario([...SETUP, `git tag '${name}'`], {
					files: { "/repo/README.md": "# Hello" },
					env: TEST_ENV,
				});
				const r = results[results.length - 1]!;
				expect(r.exitCode).not.toBe(0);
				expect(r.stderr).toContain("not a valid tag name");
			});
		}
	});

	describe("git checkout -b rejects invalid names", () => {
		for (const name of BAD_NAMES) {
			test(`rejects ${JSON.stringify(name)}`, async () => {
				const { results } = await runScenario([...SETUP, `git checkout -b '${name}'`], {
					files: { "/repo/README.md": "# Hello" },
					env: TEST_ENV,
				});
				const r = results[results.length - 1]!;
				expect(r.exitCode).not.toBe(0);
				expect(r.stderr).toContain("not a valid branch name");
			});
		}
	});

	describe("git switch -c rejects invalid names", () => {
		for (const name of BAD_NAMES) {
			test(`rejects ${JSON.stringify(name)}`, async () => {
				const { results } = await runScenario([...SETUP, `git switch -c '${name}'`], {
					files: { "/repo/README.md": "# Hello" },
					env: TEST_ENV,
				});
				const r = results[results.length - 1]!;
				expect(r.exitCode).not.toBe(0);
				expect(r.stderr).toContain("not a valid branch name");
			});
		}
	});

	test("git remote add rejects invalid name", async () => {
		const { results } = await runScenario(
			["git init", "git remote add 'has~tilde' https://example.com"],
			{ files: { "/repo/README.md": "# Hello" } },
		);
		const r = results[results.length - 1]!;
		expect(r.exitCode).not.toBe(0);
		expect(r.stderr).toContain("not a valid remote name");
	});

	test("valid names still work", async () => {
		const { results } = await runScenario(
			[...SETUP, "git branch feature", "git tag v1.0", "git checkout -b new-branch"],
			{
				files: { "/repo/README.md": "# Hello" },
				env: TEST_ENV,
			},
		);
		for (const r of results) {
			expect(r.exitCode).toBe(0);
		}
	});
});
