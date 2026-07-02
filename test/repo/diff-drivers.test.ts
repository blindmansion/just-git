import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { type DiffDriver, gitAttributes } from "../../src/lib/attributes/attribute-resolver.ts";
import { TEST_ENV } from "../fixtures.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A textconv that upper-cases the blob — easy to assert on in diff output. */
const upper: DiffDriver = {
	textconv: (_ctx, { content }) => enc.encode(dec.decode(content).toUpperCase()),
};

/** A textconv that masks `SECRET=<value>` so the raw value never reaches a diff. */
const mask: DiffDriver = {
	textconv: (_ctx, { content }) => dec.decode(content).replace(/SECRET=\S+/g, "SECRET=***"),
};

/** A funcname driver whose hunk-header pattern matches Markdown headings. */
const heading: DiffDriver = {
	funcname: /^#/,
};

async function setup(
	files: Record<string, string>,
	diffDrivers: Record<string, DiffDriver>,
): Promise<Bash> {
	const fs = new InMemoryFs();
	const git = createGit({ attributes: gitAttributes({ diffDrivers }) });
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
	await bash.exec("git init", { env: TEST_ENV });
	for (const [path, content] of Object.entries(files)) {
		await bash.writeFile(`/repo/${path}`, content);
	}
	return bash;
}

describe("diff drivers — textconv (Phase 6)", () => {
	test("git diff renders the textconv'd form of both sides", async () => {
		const bash = await setup(
			{ ".gitattributes": "*.txt diff=upper\n", "f.txt": "hello\nworld\n" },
			{ upper },
		);
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });

		await bash.writeFile("/repo/f.txt", "hello\nthere\n");
		const res = await bash.exec("git diff", { env: TEST_ENV });

		// Both old (blob) and new (worktree) sides are upper-cased before diffing.
		expect(res.stdout).toContain("-WORLD");
		expect(res.stdout).toContain("+THERE");
		// The raw lower-case form never appears — proof textconv ran on both sides.
		expect(res.stdout).not.toContain("-world");
		expect(res.stdout).not.toContain("+there");
	});

	test("git show applies textconv to a committed change", async () => {
		const bash = await setup(
			{ ".gitattributes": "*.txt diff=upper\n", "f.txt": "alpha\n" },
			{ upper },
		);
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/f.txt", "beta\n");
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m change", { env: TEST_ENV });

		const res = await bash.exec("git show HEAD", { env: TEST_ENV });
		expect(res.stdout).toContain("-ALPHA");
		expect(res.stdout).toContain("+BETA");
	});

	test("textconv keeps a secret out of the diff while still showing the change", async () => {
		const bash = await setup(
			{ ".gitattributes": "*.env diff=mask\n", "app.env": "SECRET=old\n" },
			{ mask },
		);
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/app.env", "SECRET=brandnew\n");

		const res = await bash.exec("git diff", { env: TEST_ENV });
		expect(res.stdout).not.toContain("old");
		expect(res.stdout).not.toContain("brandnew");
		// Masked form is identical on both sides ⇒ no textual hunk at all.
		expect(res.stdout).not.toContain("SECRET=***");
		expect(res.stdout.trim()).toBe("");
	});
});

describe("diff drivers — binary override (Phase 6)", () => {
	test("-diff forces 'Binary files differ' on an otherwise textual change", async () => {
		const bash = await setup({ ".gitattributes": "*.txt -diff\n", "f.txt": "one\n" }, {});
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/f.txt", "two\n");

		const res = await bash.exec("git diff", { env: TEST_ENV });
		expect(res.stdout).toContain("Binary files a/f.txt and b/f.txt differ");
		expect(res.stdout).not.toContain("+two");
	});

	test("diff (set) forces a textual diff of binary-looking content", async () => {
		// Content with a NUL byte normally trips binary detection.
		const bash = await setup({ ".gitattributes": "*.bin diff\n", "f.bin": "a\u0000b\n" }, {});
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/f.bin", "a\u0000c\n");

		const res = await bash.exec("git diff", { env: TEST_ENV });
		// Forced textual: we get a real hunk, not "Binary files differ".
		expect(res.stdout).not.toContain("Binary files");
		expect(res.stdout).toContain("@@");
	});
});

describe("diff drivers — funcname (Phase 6)", () => {
	test("custom funcname pattern drives the hunk-header context", async () => {
		const body = "# Heading\na\nb\nc\nd\ne\ntarget\n";
		const bash = await setup(
			{ ".gitattributes": "*.md diff=heading\n", "doc.md": body },
			{ heading },
		);
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/doc.md", body.replace("target", "target2"));

		const withDriver = await bash.exec("git diff", { env: TEST_ENV });
		// The `# Heading` line is outside the hunk body, so it only appears when the
		// funcname driver selects it for the `@@ … @@` context.
		expect(withDriver.stdout).toMatch(/@@.*@@ # Heading/);
	});

	test("without the driver, the default funcname scan is used", async () => {
		const body = "# Heading\na\nb\nc\nd\ne\ntarget\n";
		// No diff= attribute ⇒ built-in default funcname (letters/$/_), never '#'.
		const bash = await setup({ "doc.md": body }, {});
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/doc.md", body.replace("target", "target2"));

		const res = await bash.exec("git diff", { env: TEST_ENV });
		expect(res.stdout).not.toContain("# Heading");
	});
});

describe("diff drivers — summary formats honor the driver (Phase 6 follow-up)", () => {
	test("--numstat reports '-' for a -diff (binary) path, matching the patch", async () => {
		const bash = await setup({ ".gitattributes": "*.txt -diff\n", "f.txt": "one\n" }, {});
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/f.txt", "two\n");

		const res = await bash.exec("git diff --numstat", { env: TEST_ENV });
		// -diff ⇒ treated as binary ⇒ "-\t-", not real line counts.
		expect(res.stdout).toBe("-\t-\tf.txt\n");
	});

	test("--numstat counts real lines for a forced-textual (diff) NUL path", async () => {
		const bash = await setup({ ".gitattributes": "*.bin diff\n", "f.bin": "a\u0000b\n" }, {});
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/f.bin", "a\u0000c\n");

		const res = await bash.exec("git diff --numstat", { env: TEST_ENV });
		// Forced textual ⇒ real 1/1 counts instead of the binary "-\t-".
		expect(res.stdout).toBe("1\t1\tf.bin\n");
	});

	test("--numstat counts the textconv'd content, agreeing with the patch", async () => {
		// mask collapses both SECRET values to the same masked form ⇒ no real change.
		const bash = await setup(
			{ ".gitattributes": "*.env diff=mask\n", "app.env": "SECRET=old\n" },
			{ mask },
		);
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/app.env", "SECRET=brandnew\n");

		const res = await bash.exec("git diff --numstat", { env: TEST_ENV });
		// Masked form identical on both sides ⇒ 0/0, matching the empty patch.
		expect(res.stdout).toBe("0\t0\tapp.env\n");
	});

	test("--stat shows a Bin line for a -diff path", async () => {
		const bash = await setup({ ".gitattributes": "*.txt -diff\n", "f.txt": "one\n" }, {});
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });
		await bash.writeFile("/repo/f.txt", "two\n");

		const res = await bash.exec("git diff --stat", { env: TEST_ENV });
		expect(res.stdout).toContain("Bin");
		expect(res.stdout).not.toContain("| 2 +-");
	});
});

describe("diff drivers — combined diff honors the driver (Phase 6 follow-up)", () => {
	test("git diff --cc masks a conflicting secret instead of leaking it", async () => {
		const bash = await setup(
			{ ".gitattributes": "*.env diff=mask\n", "app.env": "SECRET=base\n" },
			{ mask },
		);
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec("git commit -m init", { env: TEST_ENV });

		await bash.exec("git checkout -b feature", { env: TEST_ENV });
		await bash.writeFile("/repo/app.env", "SECRET=fromFeature\n");
		await bash.exec("git commit -am feature", { env: TEST_ENV });

		await bash.exec("git checkout main", { env: TEST_ENV });
		await bash.writeFile("/repo/app.env", "SECRET=fromMain\n");
		await bash.exec("git commit -am main", { env: TEST_ENV });

		// Conflicting merge leaves app.env unmerged ⇒ `git diff` emits a combined diff.
		await bash.exec("git merge feature", { env: TEST_ENV });

		const res = await bash.exec("git diff", { env: TEST_ENV });
		expect(res.stdout).toContain("diff --cc app.env");
		// The raw conflicting secret values never reach the combined diff output.
		expect(res.stdout).not.toContain("fromFeature");
		expect(res.stdout).not.toContain("fromMain");
		// The masked form is what appears instead.
		expect(res.stdout).toContain("SECRET=***");
	});
});
