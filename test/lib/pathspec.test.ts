import { describe, expect, test } from "bun:test";
import {
	containsWildcard,
	matchPathspec,
	matchPathspecs,
	PATHSPEC_EXCLUDE,
	PATHSPEC_GLOB,
	PATHSPEC_ICASE,
	PATHSPEC_LITERAL,
	PATHSPEC_TOP,
	parsePathspec,
} from "../../src/lib/pathspec.ts";

// ── containsWildcard ────────────────────────────────────────────────

describe("containsWildcard", () => {
	test("plain path has no wildcards", () => {
		expect(containsWildcard("foo/bar.ts")).toBe(false);
	});

	test("detects *", () => {
		expect(containsWildcard("*.ts")).toBe(true);
	});

	test("detects ?", () => {
		expect(containsWildcard("foo?.ts")).toBe(true);
	});

	test("detects [", () => {
		expect(containsWildcard("*.[ch]")).toBe(true);
	});

	test("detects backslash", () => {
		expect(containsWildcard("foo\\*")).toBe(true);
	});
});

// ── parsePathspec — magic parsing ───────────────────────────────────

describe("parsePathspec magic", () => {
	test("no magic", () => {
		const ps = parsePathspec("*.ts", "");
		expect(ps.magic).toBe(0);
		expect(ps.pattern).toBe("*.ts");
		expect(ps.hasWildcard).toBe(true);
		expect(ps.original).toBe("*.ts");
	});

	test(":(glob)", () => {
		const ps = parsePathspec(":(glob)*.ts", "");
		expect(ps.magic & PATHSPEC_GLOB).toBeTruthy();
		expect(ps.pattern).toBe("*.ts");
	});

	test(":(literal)", () => {
		const ps = parsePathspec(":(literal)*.ts", "");
		expect(ps.magic & PATHSPEC_LITERAL).toBeTruthy();
		expect(ps.hasWildcard).toBe(false);
		expect(ps.pattern).toBe("*.ts");
	});

	test(":(icase)", () => {
		const ps = parsePathspec(":(icase)Foo", "");
		expect(ps.magic & PATHSPEC_ICASE).toBeTruthy();
		expect(ps.pattern).toBe("Foo");
	});

	test(":(top)", () => {
		const ps = parsePathspec(":(top)src/*.ts", "sub");
		expect(ps.magic & PATHSPEC_TOP).toBeTruthy();
		expect(ps.pattern).toBe("src/*.ts");
	});

	test(":(exclude)", () => {
		const ps = parsePathspec(":(exclude)*.log", "");
		expect(ps.magic & PATHSPEC_EXCLUDE).toBeTruthy();
		expect(ps.pattern).toBe("*.log");
	});

	test(":/ shorthand for top", () => {
		const ps = parsePathspec(":/src/*.ts", "sub");
		expect(ps.magic & PATHSPEC_TOP).toBeTruthy();
		expect(ps.pattern).toBe("src/*.ts");
	});

	test(":! shorthand for exclude", () => {
		const ps = parsePathspec(":!*.log", "");
		expect(ps.magic & PATHSPEC_EXCLUDE).toBeTruthy();
		expect(ps.pattern).toBe("*.log");
	});

	test(":^ shorthand for exclude", () => {
		const ps = parsePathspec(":^*.log", "");
		expect(ps.magic & PATHSPEC_EXCLUDE).toBeTruthy();
		expect(ps.pattern).toBe("*.log");
	});

	test("combined magic: :(glob,icase)", () => {
		const ps = parsePathspec(":(glob,icase)*.TS", "");
		expect(ps.magic & PATHSPEC_GLOB).toBeTruthy();
		expect(ps.magic & PATHSPEC_ICASE).toBeTruthy();
		expect(ps.pattern).toBe("*.TS");
	});

	test("literal and glob are incompatible — glob dropped", () => {
		const ps = parsePathspec(":(literal,glob)*.ts", "");
		expect(ps.magic & PATHSPEC_LITERAL).toBeTruthy();
		expect(ps.magic & PATHSPEC_GLOB).toBeFalsy();
	});
});

// ── parsePathspec — prefix resolution ───────────────────────────────

describe("parsePathspec prefix", () => {
	test("no prefix", () => {
		const ps = parsePathspec("*.ts", "");
		expect(ps.pattern).toBe("*.ts");
	});

	test("prefix prepended", () => {
		const ps = parsePathspec("*.ts", "src");
		expect(ps.pattern).toBe("src/*.ts");
	});

	test("nested prefix", () => {
		const ps = parsePathspec("*.ts", "src/lib");
		expect(ps.pattern).toBe("src/lib/*.ts");
	});

	test(".. resolves within prefix", () => {
		const ps = parsePathspec("../foo.ts", "src/sub");
		expect(ps.pattern).toBe("src/foo.ts");
	});

	test(":(top) skips prefix", () => {
		const ps = parsePathspec(":(top)*.ts", "src/lib");
		expect(ps.pattern).toBe("*.ts");
	});

	test(":/ skips prefix", () => {
		const ps = parsePathspec(":/lib/*.ts", "src");
		expect(ps.pattern).toBe("lib/*.ts");
	});

	test("literal path with prefix", () => {
		const ps = parsePathspec("foo.ts", "src");
		expect(ps.pattern).toBe("src/foo.ts");
		expect(ps.hasWildcard).toBe(false);
	});
});

// ── parsePathspec — nowildcardLen ───────────────────────────────────

describe("parsePathspec nowildcardLen", () => {
	test("all literal", () => {
		const ps = parsePathspec("foo/bar.ts", "");
		expect(ps.nowildcardLen).toBe(10);
	});

	test("wildcard at start", () => {
		const ps = parsePathspec("*.ts", "");
		expect(ps.nowildcardLen).toBe(0);
	});

	test("wildcard in middle", () => {
		const ps = parsePathspec("src/*.ts", "");
		expect(ps.nowildcardLen).toBe(4);
	});

	test("prefix extends nowildcardLen", () => {
		const ps = parsePathspec("*.ts", "src");
		expect(ps.nowildcardLen).toBe(4); // "src/"
	});

	test(":(literal) makes nowildcardLen === length", () => {
		const ps = parsePathspec(":(literal)*.ts", "");
		expect(ps.nowildcardLen).toBe(4);
	});
});

// ── matchPathspec — literal matching ────────────────────────────────

describe("matchPathspec literal", () => {
	test("exact match", () => {
		const ps = parsePathspec("foo.ts", "");
		expect(matchPathspec(ps, "foo.ts")).toBe(true);
		expect(matchPathspec(ps, "bar.ts")).toBe(false);
	});

	test("directory match", () => {
		const ps = parsePathspec("src", "");
		expect(matchPathspec(ps, "src/foo.ts")).toBe(true);
		expect(matchPathspec(ps, "src/sub/bar.ts")).toBe(true);
		expect(matchPathspec(ps, "lib/foo.ts")).toBe(false);
	});

	test("trailing slash directory match", () => {
		const ps = parsePathspec("src/", "");
		expect(matchPathspec(ps, "src/foo.ts")).toBe(true);
	});

	test("empty pattern matches everything", () => {
		const ps = parsePathspec("", "");
		expect(matchPathspec(ps, "foo.ts")).toBe(true);
		expect(matchPathspec(ps, "src/bar.ts")).toBe(true);
	});

	test("icase literal match", () => {
		const ps = parsePathspec(":(icase)FOO.ts", "");
		expect(matchPathspec(ps, "foo.ts")).toBe(true);
		expect(matchPathspec(ps, "FOO.ts")).toBe(true);
		expect(matchPathspec(ps, "Foo.ts")).toBe(true);
	});

	test(":(literal) treats wildcards as literal chars", () => {
		const ps = parsePathspec(":(literal)*.ts", "");
		expect(matchPathspec(ps, "*.ts")).toBe(true);
		expect(matchPathspec(ps, "foo.ts")).toBe(false);
	});
});

// ── matchPathspec — wildcard matching ───────────────────────────────

describe("matchPathspec wildcards", () => {
	test("*.ts matches root file", () => {
		const ps = parsePathspec("*.ts", "");
		expect(matchPathspec(ps, "foo.ts")).toBe(true);
	});

	test("default: * matches / (recursive)", () => {
		const ps = parsePathspec("*.ts", "");
		expect(matchPathspec(ps, "src/bar.ts")).toBe(true);
		expect(matchPathspec(ps, "src/sub/baz.ts")).toBe(true);
	});

	test(":(glob): * does NOT match /", () => {
		const ps = parsePathspec(":(glob)*.ts", "");
		expect(matchPathspec(ps, "foo.ts")).toBe(true);
		expect(matchPathspec(ps, "src/bar.ts")).toBe(false);
	});

	test(":(glob) with ** matches across dirs", () => {
		const ps = parsePathspec(":(glob)src/**/*.ts", "");
		expect(matchPathspec(ps, "src/foo.ts")).toBe(true);
		expect(matchPathspec(ps, "src/sub/bar.ts")).toBe(true);
		expect(matchPathspec(ps, "lib/foo.ts")).toBe(false);
	});

	test("? matches single char", () => {
		const ps = parsePathspec("fo?.ts", "");
		expect(matchPathspec(ps, "foo.ts")).toBe(true);
		expect(matchPathspec(ps, "fox.ts")).toBe(true);
		expect(matchPathspec(ps, "fooo.ts")).toBe(false);
	});

	test("character class [ch]", () => {
		const ps = parsePathspec("*.[ch]", "");
		expect(matchPathspec(ps, "foo.c")).toBe(true);
		expect(matchPathspec(ps, "foo.h")).toBe(true);
		expect(matchPathspec(ps, "foo.o")).toBe(false);
	});

	test("icase glob", () => {
		const ps = parsePathspec(":(icase)*.TS", "");
		expect(matchPathspec(ps, "foo.ts")).toBe(true);
		expect(matchPathspec(ps, "foo.TS")).toBe(true);
	});

	test("prefix applied to glob", () => {
		const ps = parsePathspec("*.ts", "src");
		expect(matchPathspec(ps, "src/foo.ts")).toBe(true);
		expect(matchPathspec(ps, "src/sub/bar.ts")).toBe(true);
		expect(matchPathspec(ps, "lib/foo.ts")).toBe(false);
	});

	test("literal prefix optimization rejects early", () => {
		const ps = parsePathspec("src/*.ts", "");
		expect(matchPathspec(ps, "lib/foo.ts")).toBe(false);
		expect(matchPathspec(ps, "src/foo.ts")).toBe(true);
	});
});

// ── matchPathspecs — multi-spec matching ────────────────────────────

describe("matchPathspecs", () => {
	test("matches if any positive spec matches", () => {
		const specs = [parsePathspec("*.ts", ""), parsePathspec("*.js", "")];
		expect(matchPathspecs(specs, "foo.ts")).toBe(true);
		expect(matchPathspecs(specs, "foo.js")).toBe(true);
		expect(matchPathspecs(specs, "foo.py")).toBe(false);
	});

	test("exclude overrides positive match", () => {
		const specs = [parsePathspec("*.ts", ""), parsePathspec(":!test.ts", "")];
		expect(matchPathspecs(specs, "foo.ts")).toBe(true);
		expect(matchPathspecs(specs, "test.ts")).toBe(false);
	});

	test("exclude pattern with wildcard", () => {
		const specs = [parsePathspec("*", ""), parsePathspec(":!*.log", "")];
		expect(matchPathspecs(specs, "foo.ts")).toBe(true);
		expect(matchPathspecs(specs, "debug.log")).toBe(false);
	});

	test("no positive specs means nothing matches", () => {
		const specs = [parsePathspec(":!*.log", "")];
		expect(matchPathspecs(specs, "foo.ts")).toBe(false);
	});
});
