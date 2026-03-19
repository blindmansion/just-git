import { describe, expect, test } from "bun:test";
import {
	formatConfigValue,
	parseConfig,
	serializeConfig,
	setConfigValueRaw,
	unsetConfigValueRaw,
} from "../../src/lib/config.ts";

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

// ── Unknown escape leniency ─────────────────────────────────────────

describe("parseConfig unknown escapes", () => {
	test("unknown escape preserves backslash", () => {
		const cfg = parseConfig("[s]\n\tkey = C:\\path\n");
		expect(cfg.s?.key).toBe("C:\\path");
	});
});

// ── formatConfigValue ───────────────────────────────────────────────

describe("formatConfigValue", () => {
	test("simple value passes through", () => {
		expect(formatConfigValue("hello")).toBe("hello");
	});

	test("escapes backslashes", () => {
		expect(formatConfigValue("C:\\Users")).toBe("C:\\\\Users");
	});

	test("quotes and escapes hash", () => {
		expect(formatConfigValue("val # comment")).toBe('"val # comment"');
	});

	test("quotes and escapes semicolon", () => {
		expect(formatConfigValue("val ; comment")).toBe('"val ; comment"');
	});

	test("quotes leading whitespace", () => {
		expect(formatConfigValue("  leading")).toBe('"  leading"');
	});

	test("quotes trailing whitespace", () => {
		expect(formatConfigValue("trailing  ")).toBe('"trailing  "');
	});

	test("escapes newlines inside quotes", () => {
		expect(formatConfigValue("line1\nline2")).toBe('"line1\\nline2"');
	});

	test("escapes tabs inside quotes", () => {
		expect(formatConfigValue("col1\tcol2")).toBe('"col1\\tcol2"');
	});

	test("escapes double quotes inside quotes", () => {
		expect(formatConfigValue('say "hi"')).toBe('"say \\"hi\\""');
	});

	test("round-trips through parseConfig", () => {
		const values = ["hello", "C:\\Users\\me", "has # hash", "  spaces  ", 'say "hi"', "a\nb"];
		for (const val of values) {
			const formatted = formatConfigValue(val);
			const cfg = parseConfig(`[s]\n\tkey = ${formatted}\n`);
			expect(cfg.s?.key).toBe(val);
		}
	});
});

// ── serializeConfig escaping ────────────────────────────────────────

describe("serializeConfig", () => {
	test("escapes values with backslashes", () => {
		const text = serializeConfig({ s: { key: "C:\\Users" } });
		expect(text).toContain("C:\\\\Users");
		const cfg = parseConfig(text);
		expect(cfg.s?.key).toBe("C:\\Users");
	});

	test("round-trips special values", () => {
		const original = { s: { path: "C:\\dir", msg: "has # hash", spaced: "  hi  " } };
		const text = serializeConfig(original);
		const parsed = parseConfig(text);
		expect(parsed.s?.path).toBe("C:\\dir");
		expect(parsed.s?.msg).toBe("has # hash");
		expect(parsed.s?.spaced).toBe("  hi  ");
	});
});

// ── setConfigValueRaw ───────────────────────────────────────────────

describe("setConfigValueRaw", () => {
	const base = `# global comment
[core]
\tbare = false
\tfilemode = true
[user]
\tname = Alice
`;

	test("replaces existing key in place", () => {
		const result = setConfigValueRaw(base, "core", "bare", "true");
		expect(result).toContain("\tbare = true\n");
		expect(result).toContain("\tfilemode = true");
		expect(result).toContain("# global comment");
	});

	test("preserves comments", () => {
		const result = setConfigValueRaw(base, "user", "name", "Bob");
		expect(result).toContain("# global comment");
	});

	test("preserves other sections", () => {
		const result = setConfigValueRaw(base, "user", "name", "Bob");
		expect(result).toContain("[core]");
		expect(result).toContain("\tbare = false");
	});

	test("appends key to existing section", () => {
		const result = setConfigValueRaw(base, "user", "email", "alice@test.com");
		expect(result).toContain("\tname = Alice");
		expect(result).toContain("\temail = alice@test.com");
		const cfg = parseConfig(result);
		expect(cfg.user?.email).toBe("alice@test.com");
	});

	test("appends new section when not found", () => {
		const result = setConfigValueRaw(base, "alias", "co", "checkout");
		expect(result).toContain("[alias]");
		expect(result).toContain("\tco = checkout");
		expect(result).toContain("# global comment");
		const cfg = parseConfig(result);
		expect(cfg.alias?.co).toBe("checkout");
	});

	test("appends subsection when not found", () => {
		const result = setConfigValueRaw(base, 'remote "origin"', "url", "https://example.com");
		expect(result).toContain('[remote "origin"]');
		expect(result).toContain("\turl = https://example.com");
	});

	test("handles empty input", () => {
		const result = setConfigValueRaw("", "core", "bare", "false");
		expect(result).toContain("[core]");
		expect(result).toContain("\tbare = false");
	});

	test("escapes special values", () => {
		const result = setConfigValueRaw(base, "user", "name", "has # hash");
		const cfg = parseConfig(result);
		expect(cfg.user?.name).toBe("has # hash");
	});

	test("replaces multi-line value", () => {
		const text = "[s]\n\tkey = hello \\\nworld\n\tother = ok\n";
		const result = setConfigValueRaw(text, "s", "key", "replaced");
		const cfg = parseConfig(result);
		expect(cfg.s?.key).toBe("replaced");
		expect(cfg.s?.other).toBe("ok");
		expect(result).not.toContain("world");
	});

	test("preserves inline comments on other lines", () => {
		const text = "[s]\n\tk1 = v1 # comment\n\tk2 = v2\n";
		const result = setConfigValueRaw(text, "s", "k2", "new");
		expect(result).toContain("k1 = v1 # comment");
	});
});

// ── unsetConfigValueRaw ─────────────────────────────────────────────

describe("unsetConfigValueRaw", () => {
	const base = `# global comment
[core]
\tbare = false
\tfilemode = true
[user]
\tname = Alice
`;

	test("removes existing key", () => {
		const { text, found } = unsetConfigValueRaw(base, "core", "filemode");
		expect(found).toBe(true);
		expect(text).not.toContain("filemode");
		expect(text).toContain("\tbare = false");
		expect(text).toContain("# global comment");
	});

	test("returns found=false for missing key", () => {
		const { text, found } = unsetConfigValueRaw(base, "core", "nonexistent");
		expect(found).toBe(false);
		expect(text).toBe(base);
	});

	test("returns found=false for missing section", () => {
		const { text, found } = unsetConfigValueRaw(base, "missing", "key");
		expect(found).toBe(false);
		expect(text).toBe(base);
	});

	test("removes section header when last key is removed", () => {
		const { text, found } = unsetConfigValueRaw(base, "user", "name");
		expect(found).toBe(true);
		expect(text).not.toContain("[user]");
		expect(text).not.toContain("Alice");
		expect(text).toContain("[core]");
	});

	test("keeps section header when other keys remain", () => {
		const { text, found } = unsetConfigValueRaw(base, "core", "bare");
		expect(found).toBe(true);
		expect(text).toContain("[core]");
		expect(text).toContain("\tfilemode = true");
	});

	test("removes multi-line value", () => {
		const text = "[s]\n\tkey = hello \\\nworld\n\tother = ok\n";
		const { text: result, found } = unsetConfigValueRaw(text, "s", "key");
		expect(found).toBe(true);
		expect(result).not.toContain("hello");
		expect(result).not.toContain("world");
		expect(result).toContain("\tother = ok");
	});

	test("preserves comments", () => {
		const { text } = unsetConfigValueRaw(base, "core", "filemode");
		expect(text).toContain("# global comment");
	});
});
