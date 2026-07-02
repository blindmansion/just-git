import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { gitAttributes } from "../../src/lib/attributes/attribute-resolver.ts";
import { createAttributesProvider } from "../../src/lib/attributes/attributes.ts";
import { bindAttributes } from "../../src/lib/attributes/bound-attributes.ts";
import { withCapabilities } from "../../src/lib/capabilities.ts";
import type { FilterConfig, FilterInput } from "../../src/lib/attributes/filters.ts";
import { readCommit } from "../../src/lib/object-db.ts";
import { findRepo } from "../../src/lib/repo.ts";
import type { GitContext, GitRepo } from "../../src/lib/types.ts";
import { flattenTree } from "../../src/repo/diffing.ts";
import { readBlobText } from "../../src/repo/reading.ts";
import { TEST_ENV } from "../fixtures.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Round-trip secret filter: hunter2 ⇄ __REDACTED__. */
const secretFilters: FilterConfig = {
	secret: {
		clean: (_ctx, { content }) =>
			enc.encode(dec.decode(content).replaceAll("hunter2", "__REDACTED__")),
		smudge: (_ctx, { content }) =>
			enc.encode(dec.decode(content).replaceAll("__REDACTED__", "hunter2")),
		required: true,
	},
};

async function getRefHash(repo: GitRepo, refName: string): Promise<string> {
	const ref = await repo.refStore.readRef(refName);
	if (!ref) throw new Error(`ref ${refName} not found`);
	if (ref.type === "symbolic") return getRefHash(repo, ref.target);
	return ref.hash;
}

async function readCommittedBlob(repo: GitRepo, path: string): Promise<string> {
	const head = await getRefHash(repo, "HEAD");
	const commit = await readCommit(repo, head);
	const entries = await flattenTree(repo, commit.tree);
	const entry = entries.find((e) => e.path === path);
	if (!entry) throw new Error(`${path} not in HEAD tree`);
	return readBlobText(repo, entry.hash);
}

/** Build an initialized repo with `.gitattributes` + the given filters. */
async function setupRepo(opts: {
	filters?: FilterConfig;
	files: Record<string, string>;
}): Promise<{ bash: Bash; fs: InMemoryFs }> {
	const fs = new InMemoryFs();
	const git = createGit(
		opts.filters ? { attributes: gitAttributes({ filters: opts.filters }) } : undefined,
	);
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
	for (const [path, content] of Object.entries(opts.files)) {
		await bash.writeFile(`/repo/${path}`, content);
	}
	await bash.exec("git init", { env: TEST_ENV });
	return { bash, fs };
}

describe("filters — clean/smudge round trip", () => {
	test("clean redacts the stored blob on add; worktree is untouched", async () => {
		const { bash, fs } = await setupRepo({
			filters: secretFilters,
			files: { ".gitattributes": "*.conf filter=secret\n", "app.conf": "SECRET=hunter2\n" },
		});

		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "init"', { env: TEST_ENV });

		const repo = (await findRepo(fs, "/repo"))!;
		// Stored blob is cleaned (redacted)…
		expect(await readCommittedBlob(repo, "app.conf")).toBe("SECRET=__REDACTED__\n");
		// …but the working file is left as-is by `add`.
		expect(await bash.readFile("/repo/app.conf")).toBe("SECRET=hunter2\n");
	});

	test("smudge restores the worktree form on checkout", async () => {
		const { bash } = await setupRepo({
			filters: secretFilters,
			files: { ".gitattributes": "*.conf filter=secret\n", "app.conf": "SECRET=hunter2\n" },
		});

		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "init"', { env: TEST_ENV });

		// Clobber the working file, then restore it from the (redacted) blob.
		await bash.writeFile("/repo/app.conf", "SECRET=clobbered\n");
		const res = await bash.exec("git checkout -- app.conf", { env: TEST_ENV });
		expect(res.exitCode).toBe(0);

		// Smudge expanded the stored __REDACTED__ back to hunter2.
		expect(await bash.readFile("/repo/app.conf")).toBe("SECRET=hunter2\n");
	});

	test("status is clean: cleaned worktree matches the stored blob", async () => {
		const { bash } = await setupRepo({
			filters: secretFilters,
			files: { ".gitattributes": "*.conf filter=secret\n", "app.conf": "SECRET=hunter2\n" },
		});

		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "init"', { env: TEST_ENV });

		const res = await bash.exec("git status --short", { env: TEST_ENV });
		// hunter2 cleans to the stored __REDACTED__ blob → no modification reported.
		expect(res.stdout.trim()).toBe("");
	});

	test("smudge receives the blob OID; clean does not", async () => {
		const fs = new InMemoryFs();
		let smudgeBlob: string | undefined = "unset";
		let cleanBlob: string | undefined = "unset";
		const filters: FilterConfig = {
			tap: {
				clean: (_ctx, input) => {
					cleanBlob = input.blobOid;
					return input.content;
				},
				smudge: (_ctx, input) => {
					smudgeBlob = input.blobOid;
					return input.content;
				},
			},
		};
		const git = createGit({ attributes: gitAttributes({ filters }) });
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/.gitattributes", "*.bin filter=tap\n");
		await bash.writeFile("/repo/a.bin", "data\n");
		await bash.exec("git init", { env: TEST_ENV });
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "init"', { env: TEST_ENV });
		await bash.writeFile("/repo/a.bin", "changed\n");
		await bash.exec("git checkout -- a.bin", { env: TEST_ENV });

		expect(cleanBlob).toBeUndefined();
		expect(smudgeBlob).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("filters — required / passthrough semantics", () => {
	test("required filter that throws is fatal on add", async () => {
		const { bash } = await setupRepo({
			filters: {
				boom: {
					required: true,
					clean: () => {
						throw new Error("nope");
					},
				},
			},
			files: { ".gitattributes": "*.dat filter=boom\n", "a.dat": "raw\n" },
		});

		const res = await bash.exec("git add .", { env: TEST_ENV });
		expect(res.exitCode).not.toBe(0);
	});

	test("non-required filter that throws falls back to passthrough", async () => {
		const { bash, fs } = await setupRepo({
			filters: {
				boom: {
					required: false,
					clean: () => {
						throw new Error("nope");
					},
				},
			},
			files: { ".gitattributes": "*.dat filter=boom\n", "a.dat": "raw-bytes\n" },
		});

		const res = await bash.exec("git add .", { env: TEST_ENV });
		expect(res.exitCode).toBe(0);
		await bash.exec('git commit -m "init"', { env: TEST_ENV });

		const repo = (await findRepo(fs, "/repo"))!;
		expect(await readCommittedBlob(repo, "a.dat")).toBe("raw-bytes\n");
	});

	test("a filter returning null is passthrough", async () => {
		const { bash, fs } = await setupRepo({
			filters: { noop: { clean: () => null } },
			files: { ".gitattributes": "*.dat filter=noop\n", "a.dat": "untouched\n" },
		});

		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "init"', { env: TEST_ENV });

		const repo = (await findRepo(fs, "/repo"))!;
		expect(await readCommittedBlob(repo, "a.dat")).toBe("untouched\n");
	});

	test("attribute naming an unregistered driver is passthrough", async () => {
		const { bash, fs } = await setupRepo({
			filters: { other: { clean: () => enc.encode("X") } },
			files: { ".gitattributes": "*.dat filter=ghost\n", "a.dat": "literal\n" },
		});

		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "init"', { env: TEST_ENV });

		const repo = (await findRepo(fs, "/repo"))!;
		expect(await readCommittedBlob(repo, "a.dat")).toBe("literal\n");
	});

	test("unattributed paths are never filtered", async () => {
		const { bash, fs } = await setupRepo({
			filters: secretFilters,
			files: { ".gitattributes": "*.conf filter=secret\n", "notes.txt": "SECRET=hunter2\n" },
		});

		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "init"', { env: TEST_ENV });

		const repo = (await findRepo(fs, "/repo"))!;
		// .txt has no filter attribute → stored verbatim.
		expect(await readCommittedBlob(repo, "notes.txt")).toBe("SECRET=hunter2\n");
	});
});

describe("filters — bindAttributes", () => {
	test("returns undefined when no attributes resolver is configured", async () => {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.exec("git init", { env: TEST_ENV });
		const repo = (await findRepo(fs, "/repo"))!;

		expect(await bindAttributes(repo as GitContext, "add")).toBeUndefined();
	});

	test("bound clean/smudge resolve via .gitattributes and registry", async () => {
		const fs = new InMemoryFs();
		const captured: FilterInput[] = [];
		const filters: FilterConfig = {
			up: {
				clean: (_ctx, input) => {
					captured.push(input);
					return enc.encode(dec.decode(input.content).toUpperCase());
				},
			},
		};
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.writeFile("/repo/.gitattributes", "*.md filter=up\n");
		await bash.exec("git init", { env: TEST_ENV });
		// lib `findRepo` does not attach capabilities; wire them explicitly.
		const repo = withCapabilities((await findRepo(fs, "/repo"))!, {
			attributes: gitAttributes({ filters }),
		});

		const bound = (await bindAttributes(repo, "add"))!;
		expect(bound).toBeDefined();

		const out = await bound.clean("readme.md", enc.encode("hello"));
		expect(dec.decode(out)).toBe("HELLO");
		expect(captured[0]!.direction).toBe("clean");
		expect(captured[0]!.path).toBe("readme.md");

		// A path with no matching attribute is passthrough.
		const untouched = await bound.clean("code.ts", enc.encode("hello"));
		expect(dec.decode(untouched)).toBe("hello");
	});
});

describe("filters — diff normalizes worktree content (Seam E)", () => {
	test("no spurious diff: cleaned worktree matches the stored blob", async () => {
		const { bash } = await setupRepo({
			filters: secretFilters,
			files: { ".gitattributes": "*.conf filter=secret\n", "app.conf": "SECRET=hunter2\n" },
		});
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "init"', { env: TEST_ENV });

		// The worktree still holds the secret form (hunter2); the blob is
		// redacted. Without cleaning the worktree side, diff would report a
		// bogus modification.
		const res = await bash.exec("git diff", { env: TEST_ENV });
		expect(res.stdout.trim()).toBe("");

		// Same for commit↔worktree (collectCommitToWorkTree).
		const head = await bash.exec("git diff HEAD", { env: TEST_ENV });
		expect(head.stdout.trim()).toBe("");
	});

	test("diff shows the cleaned representation, never the raw secret", async () => {
		const { bash } = await setupRepo({
			filters: secretFilters,
			files: { ".gitattributes": "*.conf filter=secret\n", "app.conf": "SECRET=hunter2\n" },
		});
		await bash.exec("git add .", { env: TEST_ENV });
		await bash.exec('git commit -m "init"', { env: TEST_ENV });

		// Add a new secret-bearing line in the worktree.
		await bash.writeFile("/repo/app.conf", "SECRET=hunter2\nNEW=hunter2\n");
		const res = await bash.exec("git diff", { env: TEST_ENV });

		// The added line is shown in its cleaned (redacted) form…
		expect(res.stdout).toContain("+NEW=__REDACTED__");
		// …and the raw secret never leaks into diff output.
		expect(res.stdout).not.toContain("hunter2");
	});
});

describe("attributes provider", () => {
	async function providerFor(files: Record<string, string>) {
		const fs = new InMemoryFs();
		const git = createGit();
		const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
		await bash.exec("git init", { env: TEST_ENV });
		for (const [path, content] of Object.entries(files)) {
			await bash.writeFile(`/repo/${path}`, content);
		}
		const repo = (await findRepo(fs, "/repo"))!;
		return createAttributesProvider(repo);
	}

	test("basename pattern matches at any depth", async () => {
		const p = await providerFor({ ".gitattributes": "*.conf filter=secret\n" });
		expect(await p.get("app.conf", "filter")).toBe("secret");
		expect(await p.get("deep/nested/app.conf", "filter")).toBe("secret");
		expect(await p.get("app.txt", "filter")).toBeUndefined();
	});

	test("anchored pattern with a slash only matches from the base dir", async () => {
		const p = await providerFor({ ".gitattributes": "src/*.ts filter=fmt\n" });
		expect(await p.get("src/a.ts", "filter")).toBe("fmt");
		expect(await p.get("a.ts", "filter")).toBeUndefined();
		expect(await p.get("src/deep/a.ts", "filter")).toBeUndefined();
	});

	test("deeper .gitattributes overrides the root", async () => {
		const p = await providerFor({
			".gitattributes": "*.dat filter=root\n",
			"sub/.gitattributes": "*.dat filter=sub\n",
		});
		expect(await p.get("top.dat", "filter")).toBe("root");
		expect(await p.get("sub/x.dat", "filter")).toBe("sub");
	});

	test("last matching line within a file wins", async () => {
		const p = await providerFor({ ".gitattributes": "*.dat filter=a\nfoo.dat filter=b\n" });
		expect(await p.get("foo.dat", "filter")).toBe("b");
		expect(await p.get("bar.dat", "filter")).toBe("a");
	});

	test("-filter unsets the attribute", async () => {
		const p = await providerFor({ ".gitattributes": "*.dat filter=a\nskip.dat -filter\n" });
		expect(await p.get("skip.dat", "filter")).toBe(false);
		expect(await p.get("keep.dat", "filter")).toBe("a");
	});
});
