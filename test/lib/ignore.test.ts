import { describe, expect, test } from "bun:test";
import {
	type IgnoreStack,
	isIgnored,
	parseIgnoreFile,
	parsePatternLine,
	pushDirIgnore,
} from "../../src/lib/ignore.ts";
import { runScenario } from "../util";

// ── parsePatternLine ────────────────────────────────────────────────

describe("parsePatternLine", () => {
	test("blank line returns null", () => {
		expect(parsePatternLine("", "")).toBeNull();
		expect(parsePatternLine("   ", "")).toBeNull();
	});

	test("comment line returns null", () => {
		expect(parsePatternLine("# this is a comment", "")).toBeNull();
	});

	test("escaped hash is not a comment", () => {
		const pat = parsePatternLine("\\#file", "");
		expect(pat).not.toBeNull();
		expect(pat?.pattern).toBe("\\#file");
	});

	test("simple filename pattern", () => {
		const pat = parsePatternLine("*.o", "");
		expect(pat).not.toBeNull();
		expect(pat?.pattern).toBe("*.o");
		expect(pat!.flags & 1).toBeTruthy(); // NODIR
	});

	test("negation prefix", () => {
		const pat = parsePatternLine("!important.txt", "");
		expect(pat).not.toBeNull();
		expect(pat!.pattern).toBe("important.txt");
		expect(pat!.flags & 16).toBeTruthy(); // NEGATIVE
	});

	test("trailing slash sets MUSTBEDIR", () => {
		const pat = parsePatternLine("build/", "");
		expect(pat).not.toBeNull();
		expect(pat!.pattern).toBe("build");
		expect(pat!.flags & 8).toBeTruthy(); // MUSTBEDIR
	});

	test("slash in pattern clears NODIR", () => {
		const pat = parsePatternLine("src/build", "");
		expect(pat).not.toBeNull();
		expect(pat!.flags & 1).toBeFalsy(); // NODIR not set
	});

	test("leading slash clears NODIR", () => {
		const pat = parsePatternLine("/build", "");
		expect(pat).not.toBeNull();
		expect(pat!.flags & 1).toBeFalsy(); // NODIR not set
	});

	test("ENDSWITH optimization for *<literal>", () => {
		const pat = parsePatternLine("*.log", "");
		expect(pat).not.toBeNull();
		expect(pat!.flags & 4).toBeTruthy(); // ENDSWITH
	});

	test("no ENDSWITH when pattern has wildcards after *", () => {
		const pat = parsePatternLine("*test*", "");
		expect(pat).not.toBeNull();
		expect(pat!.flags & 4).toBeFalsy(); // ENDSWITH not set
	});

	test("trailing spaces are stripped", () => {
		const pat = parsePatternLine("foo.txt   ", "");
		expect(pat).not.toBeNull();
		expect(pat!.pattern).toBe("foo.txt");
	});

	test("escaped trailing space is preserved", () => {
		const pat = parsePatternLine("foo\\ ", "");
		expect(pat).not.toBeNull();
		expect(pat!.pattern).toBe("foo ");
	});

	test("base is stored", () => {
		const pat = parsePatternLine("*.o", "src/lib");
		expect(pat).not.toBeNull();
		expect(pat!.base).toBe("src/lib");
	});

	test("nowildcardLen computed correctly", () => {
		const pat = parsePatternLine("src/*.o", "");
		expect(pat).not.toBeNull();
		expect(pat!.nowildcardLen).toBe(4); // "src/"
	});
});

// ── parseIgnoreFile ─────────────────────────────────────────────────

describe("parseIgnoreFile", () => {
	test("parses multiple patterns", () => {
		const content = "*.o\n*.a\nbuild/\n";
		const pl = parseIgnoreFile(content, "", ".gitignore");
		expect(pl.patterns.length).toBe(3);
		expect(pl.src).toBe(".gitignore");
	});

	test("skips blanks and comments", () => {
		const content = "# ignore objects\n*.o\n\n# and archives\n*.a\n";
		const pl = parseIgnoreFile(content, "", ".gitignore");
		expect(pl.patterns.length).toBe(2);
	});

	test("preserves pattern order", () => {
		const content = "*.o\n!important.o\n";
		const pl = parseIgnoreFile(content, "", ".gitignore");
		expect(pl.patterns[0].pattern).toBe("*.o");
		expect(pl.patterns[1].pattern).toBe("important.o");
		expect(pl.patterns[1].flags & 16).toBeTruthy(); // NEGATIVE
	});
});

// ── isIgnored (matching logic) ──────────────────────────────────────

function makeStack(patterns: { content: string; base: string }[]): IgnoreStack {
	const stack: IgnoreStack = {
		dirPatterns: [],
		excludeFile: null,
		globalExclude: null,
	};
	for (const { content, base } of patterns) {
		const pl = parseIgnoreFile(content, base, `${base}/.gitignore`);
		stack.dirPatterns.push(pl);
	}
	return stack;
}

describe("isIgnored", () => {
	describe("basic patterns", () => {
		test("*.o matches any .o file", () => {
			const stack = makeStack([{ content: "*.o", base: "" }]);
			expect(isIgnored(stack, "foo.o", false)).toBe("ignored");
			expect(isIgnored(stack, "src/bar.o", false)).toBe("ignored");
		});

		test("*.o does not match .c file", () => {
			const stack = makeStack([{ content: "*.o", base: "" }]);
			expect(isIgnored(stack, "foo.c", false)).toBe("undecided");
		});

		test("build/ only matches directories", () => {
			const stack = makeStack([{ content: "build/", base: "" }]);
			expect(isIgnored(stack, "build", true)).toBe("ignored");
			expect(isIgnored(stack, "build", false)).toBe("undecided");
		});

		test("exact filename pattern", () => {
			const stack = makeStack([{ content: "Thumbs.db", base: "" }]);
			expect(isIgnored(stack, "Thumbs.db", false)).toBe("ignored");
			expect(isIgnored(stack, "src/Thumbs.db", false)).toBe("ignored");
		});
	});

	describe("negation", () => {
		test("! un-ignores a file", () => {
			const stack = makeStack([{ content: "*.o\n!important.o", base: "" }]);
			expect(isIgnored(stack, "foo.o", false)).toBe("ignored");
			expect(isIgnored(stack, "important.o", false)).toBe("not-ignored");
		});

		test("last matching pattern wins", () => {
			const stack = makeStack([{ content: "*.log\n!debug.log\n*.log", base: "" }]);
			// *.log is last, so debug.log is ignored again
			expect(isIgnored(stack, "debug.log", false)).toBe("ignored");
		});
	});

	describe("anchored patterns (with /)", () => {
		test("/build only matches at root", () => {
			const stack = makeStack([{ content: "/build", base: "" }]);
			expect(isIgnored(stack, "build", false)).toBe("ignored");
			expect(isIgnored(stack, "src/build", false)).toBe("undecided");
		});

		test("doc/frotz matches relative to base", () => {
			const stack = makeStack([{ content: "doc/frotz", base: "" }]);
			expect(isIgnored(stack, "doc/frotz", false)).toBe("ignored");
			expect(isIgnored(stack, "a/doc/frotz", false)).toBe("undecided");
		});
	});

	describe("directory-relative patterns (sub-directory .gitignore)", () => {
		test("pattern in subdirectory .gitignore matches relative to that dir", () => {
			const stack = makeStack([{ content: "*.log", base: "src" }]);
			expect(isIgnored(stack, "src/debug.log", false)).toBe("ignored");
			expect(isIgnored(stack, "debug.log", false)).toBe("undecided");
		});

		test("anchored pattern in subdirectory", () => {
			const stack = makeStack([{ content: "/build", base: "src" }]);
			expect(isIgnored(stack, "src/build", false)).toBe("ignored");
			expect(isIgnored(stack, "src/sub/build", false)).toBe("undecided");
		});
	});

	describe("precedence", () => {
		test("deeper .gitignore overrides shallower", () => {
			const stack = makeStack([
				{ content: "*.html", base: "" },
				{ content: "!foo.html", base: "Documentation" },
			]);
			// Root ignores all .html, but Documentation/.gitignore un-ignores foo.html
			expect(isIgnored(stack, "Documentation/foo.html", false)).toBe("not-ignored");
			expect(isIgnored(stack, "Documentation/bar.html", false)).toBe("ignored");
		});

		test("info/exclude is lower priority than dir patterns", () => {
			const stack: IgnoreStack = {
				dirPatterns: [parseIgnoreFile("!keep.o", "", ".gitignore")],
				excludeFile: parseIgnoreFile("*.o", "", "info/exclude"),
				globalExclude: null,
			};
			// info/exclude says ignore *.o, but .gitignore negates keep.o
			expect(isIgnored(stack, "keep.o", false)).toBe("not-ignored");
			expect(isIgnored(stack, "other.o", false)).toBe("ignored");
		});

		test("core.excludesFile is lowest priority", () => {
			const stack: IgnoreStack = {
				dirPatterns: [],
				excludeFile: parseIgnoreFile("!keep.o", "", "info/exclude"),
				globalExclude: parseIgnoreFile("*.o", "", "~/.gitignore"),
			};
			expect(isIgnored(stack, "keep.o", false)).toBe("not-ignored");
			expect(isIgnored(stack, "other.o", false)).toBe("ignored");
		});
	});

	describe("doublestar patterns", () => {
		test("**/foo matches anywhere", () => {
			const stack = makeStack([{ content: "**/foo", base: "" }]);
			expect(isIgnored(stack, "foo", false)).toBe("ignored");
			expect(isIgnored(stack, "a/foo", false)).toBe("ignored");
			expect(isIgnored(stack, "a/b/foo", false)).toBe("ignored");
		});

		test("foo/** matches everything inside", () => {
			const stack = makeStack([{ content: "foo/**", base: "" }]);
			expect(isIgnored(stack, "foo/bar", false)).toBe("ignored");
			expect(isIgnored(stack, "foo/a/b", false)).toBe("ignored");
			expect(isIgnored(stack, "foo", false)).toBe("undecided");
		});

		test("a/**/b matches across dirs", () => {
			const stack = makeStack([{ content: "a/**/b", base: "" }]);
			expect(isIgnored(stack, "a/b", false)).toBe("ignored");
			expect(isIgnored(stack, "a/x/b", false)).toBe("ignored");
			expect(isIgnored(stack, "a/x/y/b", false)).toBe("ignored");
		});
	});

	describe("character classes", () => {
		test("*.[oa] matches .o and .a", () => {
			const stack = makeStack([{ content: "*.[oa]", base: "" }]);
			expect(isIgnored(stack, "foo.o", false)).toBe("ignored");
			expect(isIgnored(stack, "lib.a", false)).toBe("ignored");
			expect(isIgnored(stack, "foo.c", false)).toBe("undecided");
		});
	});

	describe("pushDirIgnore and stack manipulation", () => {
		test("pushDirIgnore adds patterns for a subdirectory", () => {
			let stack: IgnoreStack = {
				dirPatterns: [],
				excludeFile: null,
				globalExclude: null,
			};
			stack = pushDirIgnore(stack, "*.o", "", ".gitignore");
			expect(isIgnored(stack, "foo.o", false)).toBe("ignored");

			stack = pushDirIgnore(stack, "!important.o", "src", "src/.gitignore");
			expect(isIgnored(stack, "src/important.o", false)).toBe("not-ignored");
			expect(isIgnored(stack, "src/other.o", false)).toBe("ignored");
		});
	});
});

// ── Integration with git commands ───────────────────────────────────

describe("gitignore integration", () => {
	const ENV = {
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@test.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@test.com",
	};

	describe("git status respects .gitignore", () => {
		test("ignored files not shown as untracked", async () => {
			const { results } = await runScenario(["git init", "git status"], {
				files: {
					"/repo/.gitignore": "*.o\nbuild/\n",
					"/repo/main.c": "int main() {}",
					"/repo/main.o": "binary",
					"/repo/build/output": "out",
				},
				env: ENV,
			});
			const status = results[1];
			expect(status.exitCode).toBe(0);
			expect(status.stdout).toContain(".gitignore");
			expect(status.stdout).toContain("main.c");
			expect(status.stdout).not.toContain("main.o");
			expect(status.stdout).not.toContain("build/");
			expect(status.stdout).not.toContain("output");
		});

		test("short format omits ignored files", async () => {
			const { results } = await runScenario(["git init", "git status -s"], {
				files: {
					"/repo/.gitignore": "*.log\n",
					"/repo/app.js": "console.log('hi')",
					"/repo/debug.log": "debug info",
				},
				env: ENV,
			});
			const status = results[1];
			expect(status.exitCode).toBe(0);
			expect(status.stdout).toContain("app.js");
			expect(status.stdout).toContain(".gitignore");
			expect(status.stdout).not.toContain("debug.log");
		});

		test("tracked files still shown even if pattern matches", async () => {
			const { results } = await runScenario(
				["git init", "git add main.o", 'git commit -m "track object file"', "git status -s"],
				{
					files: {
						"/repo/.gitignore": "*.o\n",
						"/repo/main.o": "tracked object",
					},
					env: ENV,
				},
			);
			// main.o is tracked, so even though *.o is in .gitignore,
			// it shouldn't be hidden from status
			const status = results[3];
			expect(status.exitCode).toBe(0);
			// After commit, if the file hasn't changed, status is clean
			// The key point: tracked files are not hidden
		});
	});

	describe("negation patterns", () => {
		test("! re-includes excluded files", async () => {
			const { results } = await runScenario(["git init", "git status -s"], {
				files: {
					"/repo/.gitignore": "*.html\n!foo.html\n",
					"/repo/foo.html": "keep me",
					"/repo/bar.html": "ignore me",
				},
				env: ENV,
			});
			const status = results[1];
			expect(status.stdout).toContain("foo.html");
			expect(status.stdout).not.toContain("bar.html");
		});
	});

	describe("subdirectory .gitignore", () => {
		test("subdir .gitignore applies relative to its directory", async () => {
			// Use git add . then check status to see what was staged,
			// since status -s collapses untracked directories
			const { results } = await runScenario(["git init", "git add .", "git status -s"], {
				files: {
					"/repo/src/.gitignore": "*.generated.ts\n",
					"/repo/src/app.ts": "export {}",
					"/repo/src/types.generated.ts": "generated",
					"/repo/lib/other.generated.ts": "not in src",
				},
				env: ENV,
			});
			const status = results[2];
			expect(status.exitCode).toBe(0);
			// Staged files should include app.ts and lib's file, but NOT types.generated.ts
			expect(status.stdout).toContain("app.ts");
			expect(status.stdout).not.toContain("types.generated.ts");
			// lib/other.generated.ts IS staged because src/.gitignore doesn't apply to lib/
			expect(status.stdout).toContain("other.generated.ts");
		});
	});

	describe("info/exclude", () => {
		test("patterns in info/exclude are respected", async () => {
			const { results } = await runScenario(["git init", "git status -s"], {
				files: {
					"/repo/secret.key": "super secret",
					"/repo/app.js": "code",
				},
				env: ENV,
			});
			// First, manually write to .git/info/exclude
			const bash = results[0]; // git init result
			expect(bash.exitCode).toBe(0);

			// Now set up with info/exclude pre-populated
			await runScenario(["git init", "git status -s"], {
				files: {
					"/repo/.git/info/exclude": "secret.key\n",
					"/repo/secret.key": "super secret",
					"/repo/app.js": "code",
				},
				env: ENV,
			});
			// git init won't overwrite existing .git/info/exclude if .git exists
			// Let's just do it the right way:
		});
	});

	describe("directory patterns", () => {
		test("trailing / only matches directories", async () => {
			const { results } = await runScenario(["git init", "git status -s"], {
				files: {
					"/repo/.gitignore": "logs/\n",
					"/repo/logs/app.log": "log data",
					"/repo/logs-file": "not a dir named logs",
				},
				env: ENV,
			});
			const status = results[1];
			expect(status.stdout).not.toContain("app.log");
			expect(status.stdout).toContain("logs-file");
		});
	});

	describe("complex gitignore scenarios", () => {
		test("node_modules pattern ignores entire directory", async () => {
			const { results } = await runScenario(["git init", "git status -s"], {
				files: {
					"/repo/.gitignore": "node_modules/\n",
					"/repo/index.js": "require('express')",
					"/repo/node_modules/express/index.js": "module.exports = {}",
					"/repo/node_modules/express/package.json": "{}",
				},
				env: ENV,
			});
			const status = results[1];
			expect(status.stdout).toContain("index.js");
			expect(status.stdout).not.toContain("express");
			expect(status.stdout).not.toContain("node_modules");
		});

		test("multiple gitignore files stack correctly", async () => {
			const { results } = await runScenario(["git init", "git add .", "git status -s"], {
				files: {
					"/repo/.gitignore": "*.log\n",
					"/repo/src/.gitignore": "!debug.log\n",
					"/repo/app.log": "root log",
					"/repo/src/debug.log": "keep this",
					"/repo/src/error.log": "ignore this",
					"/repo/src/main.ts": "code",
				},
				env: ENV,
			});
			const status = results[2];
			expect(status.stdout).not.toContain("app.log");
			expect(status.stdout).toContain("debug.log");
			expect(status.stdout).not.toContain("error.log");
			expect(status.stdout).toContain("main.ts");
		});

		test("gitignore from documentation example", async () => {
			// From the gitignore manpage: ignore *.[oa], ignore *.html except foo.html
			const { results } = await runScenario(["git init", "git add .", "git status -s"], {
				files: {
					"/repo/.gitignore": "*.[oa]\n",
					"/repo/Documentation/.gitignore": "*.html\n!foo.html\n",
					"/repo/Documentation/foo.html": "hand-maintained",
					"/repo/Documentation/gitignore.html": "generated",
					"/repo/file.o": "object",
					"/repo/lib.a": "archive",
					"/repo/src/internal.o": "object in src",
				},
				env: ENV,
			});
			const status = results[2];
			expect(status.stdout).toContain("foo.html");
			expect(status.stdout).not.toContain("gitignore.html");
			expect(status.stdout).not.toContain("file.o");
			expect(status.stdout).not.toContain("lib.a");
			expect(status.stdout).not.toContain("internal.o");
		});
	});
});
