import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { gitAttributes } from "../../src/lib/attributes/attribute-resolver.ts";
import { bindAttributes } from "../../src/lib/attributes/bound-attributes.ts";
import { TEST_ENV } from "../fixtures.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Init an in-memory repo with the given files (incl. `.gitattributes`). */
async function setup(files: Record<string, string>): Promise<{ bash: Bash; fs: InMemoryFs }> {
	const fs = new InMemoryFs();
	const git = createGit();
	const bash = new Bash({ fs, cwd: "/repo", env: TEST_ENV, customCommands: [git] });
	for (const [path, content] of Object.entries(files)) {
		await bash.writeFile(`/repo/${path}`, content);
	}
	await bash.exec("git init");
	return { bash, fs };
}

describe("git check-attr", () => {
	test("reports a single attribute for a path", async () => {
		const { bash } = await setup({ ".gitattributes": "*.conf filter=secret\n" });
		const res = await bash.exec("git check-attr filter app.conf");
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("app.conf: filter: secret\n");
	});

	test("reports set / unset / unspecified / value words", async () => {
		const { bash } = await setup({
			".gitattributes": "*.txt text\n*.bin -text\n*.conf filter=secret\n",
		});
		const res = await bash.exec("git check-attr text filter -- a.txt a.bin a.conf other.md");
		expect(res.stdout).toBe(
			[
				"a.txt: text: set",
				"a.txt: filter: unspecified",
				"a.bin: text: unset",
				"a.bin: filter: unspecified",
				"a.conf: text: unspecified",
				"a.conf: filter: secret",
				"other.md: text: unspecified",
				"other.md: filter: unspecified",
				"",
			].join("\n"),
		);
	});

	test("bare form: first token is the attr, the rest are paths", async () => {
		const { bash } = await setup({ ".gitattributes": "*.conf filter=secret\n" });
		const res = await bash.exec("git check-attr filter app.conf other.conf");
		expect(res.stdout).toBe("app.conf: filter: secret\nother.conf: filter: secret\n");
	});

	test("--all lists every decided attribute, sorted", async () => {
		const { bash } = await setup({
			".gitattributes": "*.conf filter=secret diff=conf text\n",
		});
		const res = await bash.exec("git check-attr --all app.conf");
		expect(res.stdout).toBe(
			["app.conf: diff: conf", "app.conf: filter: secret", "app.conf: text: set", ""].join("\n"),
		);
	});

	test("--all emits nothing for a path with no attributes", async () => {
		const { bash } = await setup({ ".gitattributes": "*.conf filter=secret\n" });
		const res = await bash.exec("git check-attr --all plain.md");
		expect(res.stdout).toBe("");
	});

	test("--stdin reads newline-separated paths", async () => {
		const { bash } = await setup({ ".gitattributes": "*.conf filter=secret\n" });
		const res = await bash.exec("git check-attr filter --stdin", {
			stdin: "app.conf\nother.conf\n",
		});
		expect(res.stdout).toBe("app.conf: filter: secret\nother.conf: filter: secret\n");
	});

	test("-z makes stdin and output NUL-separated", async () => {
		const { bash } = await setup({ ".gitattributes": "*.conf filter=secret\n" });
		const res = await bash.exec("git check-attr -z filter --stdin", {
			stdin: "app.conf\0sub/app.conf\0",
		});
		expect(res.stdout).toBe("app.conf\0filter\0secret\0sub/app.conf\0filter\0secret\0");
	});

	test("deeper .gitattributes overrides the root", async () => {
		const { bash } = await setup({
			".gitattributes": "*.dat filter=root\n",
			"sub/.gitattributes": "*.dat filter=sub\n",
		});
		const res = await bash.exec("git check-attr filter -- top.dat sub/x.dat");
		expect(res.stdout).toBe("top.dat: filter: root\nsub/x.dat: filter: sub\n");
	});

	test("resolves paths relative to the current directory, echoing the argument", async () => {
		const { bash } = await setup({
			".gitattributes": "*.dat filter=root\n",
			"sub/.gitattributes": "*.dat filter=sub\n",
			"sub/x.dat": "x\n",
		});
		const res = await bash.exec("git check-attr filter x.dat", { cwd: "/repo/sub" });
		// The lookup uses sub/x.dat, but the output echoes the argument as given.
		expect(res.stdout).toBe("x.dat: filter: sub\n");
	});

	test("errors when no attribute is specified without --all", async () => {
		const { bash } = await setup({ ".gitattributes": "*.conf filter=secret\n" });
		const res = await bash.exec("git check-attr");
		expect(res.exitCode).toBe(128);
		expect(res.stderr).toContain("No attribute specified");
	});

	test("matches the engine's selection (no drift)", async () => {
		// check-attr reads the same in-tree provider the resolver does, so the
		// value it reports lines up with the filter the engine actually runs.
		const fs = new InMemoryFs();
		const filters = {
			up: {
				clean: (_c: unknown, i: { content: Uint8Array }) =>
					enc.encode(dec.decode(i.content).toUpperCase()),
			},
		};
		const git = createGit({ attributes: gitAttributes({ filters }) });
		const bash = new Bash({ fs, cwd: "/repo", env: TEST_ENV, customCommands: [git] });
		await bash.writeFile("/repo/.gitattributes", "*.md filter=up\n");
		await bash.exec("git init");

		const reported = await bash.exec("git check-attr filter -- readme.md code.ts");
		expect(reported.stdout).toBe("readme.md: filter: up\ncode.ts: filter: unspecified\n");

		// `git.findRepo` (unlike lib `findRepo`) attaches the configured capabilities.
		const repo = (await git.findRepo({ fs, cwd: "/repo" }))!;
		const bound = (await bindAttributes(repo, "add"))!;
		// Attributed by check-attr → actually filtered by the engine…
		expect(dec.decode(await bound.clean("readme.md", enc.encode("hello")))).toBe("HELLO");
		// …unspecified by check-attr → passthrough in the engine.
		expect(dec.decode(await bound.clean("code.ts", enc.encode("hello")))).toBe("hello");
	});
});
