import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../src/lib/config.ts";

// ── Basic parsing ───────────────────────────────────────────────────

describe("parseConfig basics", () => {
	test("simple section with key=value", () => {
		const cfg = parseConfig("[core]\n\tbare = false\n");
		expect(cfg.core?.bare).toBe("false");
	});

	test("multiple sections", () => {
		const cfg = parseConfig("[core]\n\tbare = false\n[user]\n\tname = Alice\n");
		expect(cfg.core?.bare).toBe("false");
		expect(cfg.user?.name).toBe("Alice");
	});

	test("valueless key is boolean true", () => {
		const cfg = parseConfig("[core]\n\tbare\n");
		expect(cfg.core?.bare).toBe("true");
	});

	test("keys are lowercased", () => {
		const cfg = parseConfig("[core]\n\tMyKey = val\n");
		expect(cfg.core?.mykey).toBe("val");
	});

	test("section names are lowercased", () => {
		const cfg = parseConfig("[Core]\n\tkey = val\n");
		expect(cfg.core?.key).toBe("val");
	});

	test("skips empty lines and comments", () => {
		const text = "# comment\n[core]\n\n; another comment\n\tkey = val\n";
		const cfg = parseConfig(text);
		expect(cfg.core?.key).toBe("val");
	});

	test("duplicate keys keep last value", () => {
		const cfg = parseConfig("[core]\n\tkey = first\n\tkey = second\n");
		expect(cfg.core?.key).toBe("second");
	});

	test("duplicate sections merge entries", () => {
		const cfg = parseConfig("[core]\n\ta = 1\n[core]\n\tb = 2\n");
		expect(cfg.core?.a).toBe("1");
		expect(cfg.core?.b).toBe("2");
	});
});

// ── Subsection headers ──────────────────────────────────────────────

describe("parseConfig section headers", () => {
	test("quoted subsection", () => {
		const cfg = parseConfig('[remote "origin"]\n\turl = https://example.com\n');
		expect(cfg['remote "origin"']?.url).toBe("https://example.com");
	});

	test("quoted subsection preserves case", () => {
		const cfg = parseConfig('[branch "MyBranch"]\n\tmerge = refs/heads/MyBranch\n');
		expect(cfg['branch "MyBranch"']?.merge).toBe("refs/heads/MyBranch");
	});

	test("dot-notation subsection", () => {
		const cfg = parseConfig("[branch.main]\n\tremote = origin\n");
		expect(cfg['branch "main"']?.remote).toBe("origin");
	});

	test("dot-notation subsection is lowercased", () => {
		const cfg = parseConfig("[branch.Main]\n\tremote = origin\n");
		expect(cfg['branch "main"']?.remote).toBe("origin");
	});

	test("escaped characters in quoted subsection", () => {
		const cfg = parseConfig('[section "sub\\"sec"]\n\tkey = val\n');
		expect(cfg['section "sub"sec"']?.key).toBe("val");
	});

	test("backslash in quoted subsection", () => {
		const cfg = parseConfig('[section "path\\\\dir"]\n\tkey = val\n');
		expect(cfg['section "path\\dir"']?.key).toBe("val");
	});
});

// ── Value quoting ───────────────────────────────────────────────────

describe("parseConfig value quoting", () => {
	test("unquoted value", () => {
		const cfg = parseConfig("[s]\n\tkey = hello\n");
		expect(cfg.s?.key).toBe("hello");
	});

	test("quoted value", () => {
		const cfg = parseConfig('[s]\n\tkey = "hello world"\n');
		expect(cfg.s?.key).toBe("hello world");
	});

	test("quoted value preserves leading/trailing spaces", () => {
		const cfg = parseConfig('[s]\n\tkey = "  spaced  "\n');
		expect(cfg.s?.key).toBe("  spaced  ");
	});

	test("unquoted value trims trailing whitespace", () => {
		const cfg = parseConfig("[s]\n\tkey = hello   \n");
		expect(cfg.s?.key).toBe("hello");
	});

	test("unquoted value trims leading whitespace", () => {
		const cfg = parseConfig("[s]\n\tkey =   hello\n");
		expect(cfg.s?.key).toBe("hello");
	});

	test("unquoted value preserves internal whitespace", () => {
		const cfg = parseConfig("[s]\n\tkey = hello   world\n");
		expect(cfg.s?.key).toBe("hello   world");
	});

	test("mixed quoted and unquoted segments", () => {
		const cfg = parseConfig('[s]\n\tkey = hello" world "\n');
		expect(cfg.s?.key).toBe("hello world ");
	});

	test("empty quoted value", () => {
		const cfg = parseConfig('[s]\n\tkey = ""\n');
		expect(cfg.s?.key).toBe("");
	});

	test("empty unquoted value (key = )", () => {
		const cfg = parseConfig("[s]\n\tkey = \n");
		expect(cfg.s?.key).toBe("");
	});
});

// ── Escape sequences ───────────────────────────────────────────────

describe("parseConfig escape sequences", () => {
	test("escaped backslash", () => {
		const cfg = parseConfig("[s]\n\tkey = C:\\\\Users\\\\me\n");
		expect(cfg.s?.key).toBe("C:\\Users\\me");
	});

	test("escaped quote in quoted value", () => {
		const cfg = parseConfig('[s]\n\tkey = "say \\"hi\\""\n');
		expect(cfg.s?.key).toBe('say "hi"');
	});

	test("escaped newline (\\n)", () => {
		const cfg = parseConfig('[s]\n\tkey = "line1\\nline2"\n');
		expect(cfg.s?.key).toBe("line1\nline2");
	});

	test("escaped tab (\\t)", () => {
		const cfg = parseConfig('[s]\n\tkey = "col1\\tcol2"\n');
		expect(cfg.s?.key).toBe("col1\tcol2");
	});

	test("escaped backspace (\\b)", () => {
		const cfg = parseConfig('[s]\n\tkey = "a\\b"\n');
		expect(cfg.s?.key).toBe("a\b");
	});

	test("escape sequences work outside quotes too", () => {
		const cfg = parseConfig("[s]\n\tkey = C:\\\\Users\n");
		expect(cfg.s?.key).toBe("C:\\Users");
	});
});

// ── Inline comments ─────────────────────────────────────────────────

describe("parseConfig inline comments", () => {
	test("hash comment after value", () => {
		const cfg = parseConfig("[s]\n\tkey = value # this is a comment\n");
		expect(cfg.s?.key).toBe("value");
	});

	test("semicolon comment after value", () => {
		const cfg = parseConfig("[s]\n\tkey = value ; this is a comment\n");
		expect(cfg.s?.key).toBe("value");
	});

	test("hash inside quotes is not a comment", () => {
		const cfg = parseConfig('[s]\n\tkey = "value # not a comment"\n');
		expect(cfg.s?.key).toBe("value # not a comment");
	});

	test("semicolon inside quotes is not a comment", () => {
		const cfg = parseConfig('[s]\n\tkey = "value ; not a comment"\n');
		expect(cfg.s?.key).toBe("value ; not a comment");
	});

	test("comment with no space before it", () => {
		const cfg = parseConfig("[s]\n\tkey = value#comment\n");
		expect(cfg.s?.key).toBe("value");
	});
});

// ── Multi-line continuation ─────────────────────────────────────────

describe("parseConfig continuation lines", () => {
	test("backslash at end of line continues value", () => {
		const cfg = parseConfig("[s]\n\tkey = hello \\\nworld\n");
		expect(cfg.s?.key).toBe("hello world");
	});

	test("multiple continuation lines", () => {
		const cfg = parseConfig("[s]\n\tkey = a \\\nb \\\nc\n");
		expect(cfg.s?.key).toBe("a b c");
	});

	test("continuation inside quotes", () => {
		const cfg = parseConfig('[s]\n\tkey = "hello \\\nworld"\n');
		expect(cfg.s?.key).toBe("hello world");
	});

	test("next key after continuation value", () => {
		const cfg = parseConfig("[s]\n\tk1 = a \\\nb\n\tk2 = c\n");
		expect(cfg.s?.k1).toBe("a b");
		expect(cfg.s?.k2).toBe("c");
	});
});

// ── CRLF handling ───────────────────────────────────────────────────

describe("parseConfig CRLF", () => {
	test("handles \\r\\n line endings", () => {
		const cfg = parseConfig("[core]\r\n\tbare = false\r\n");
		expect(cfg.core?.bare).toBe("false");
	});

	test("\\r in value is stripped", () => {
		const cfg = parseConfig("[s]\n\tkey = value\r\n");
		expect(cfg.s?.key).toBe("value");
	});
});

// ── Real git output format ──────────────────────────────────────────

describe("parseConfig real git format", () => {
	test("typical git init config", () => {
		const text = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = true
\tignorecase = true
\tprecomposeunicode = true
`;
		const cfg = parseConfig(text);
		expect(cfg.core?.repositoryformatversion).toBe("0");
		expect(cfg.core?.filemode).toBe("true");
		expect(cfg.core?.bare).toBe("false");
		expect(cfg.core?.logallrefupdates).toBe("true");
	});

	test("remote + branch tracking config", () => {
		const text = `[remote "origin"]
\turl = https://github.com/user/repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
\tmerge = refs/heads/main
`;
		const cfg = parseConfig(text);
		expect(cfg['remote "origin"']?.url).toBe("https://github.com/user/repo.git");
		expect(cfg['remote "origin"']?.fetch).toBe("+refs/heads/*:refs/remotes/origin/*");
		expect(cfg['branch "main"']?.remote).toBe("origin");
		expect(cfg['branch "main"']?.merge).toBe("refs/heads/main");
	});

	test("config with comments interleaved", () => {
		const text = `# This is the config file
[core]
\t# repositoryformatversion
\trepositoryformatversion = 0
; old-style comment
\tbare = false
`;
		const cfg = parseConfig(text);
		expect(cfg.core?.repositoryformatversion).toBe("0");
		expect(cfg.core?.bare).toBe("false");
	});
});
