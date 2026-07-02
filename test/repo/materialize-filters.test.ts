import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { gitAttributes } from "../../src/lib/attributes/attribute-resolver.ts";
import { createTreeAttributesProvider } from "../../src/lib/attributes/attributes.ts";
import { withCapabilities } from "../../src/lib/capabilities.ts";
import type { FilterConfig } from "../../src/lib/attributes/filters.ts";
import { readCommit } from "../../src/lib/object-db.ts";
import { findRepo } from "../../src/lib/repo.ts";
import type { GitRepo } from "../../src/lib/types.ts";
import { createTreeAccessor } from "../../src/repo/tree-accessor.ts";
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

/**
 * Commit a tree with the secret filter active, so stored blobs are in cleaned
 * (redacted) form. Returns a bare (capability-less) repo handle + the tree hash.
 */
async function setupTree(): Promise<{ bare: GitRepo; treeHash: string }> {
	const fs = new InMemoryFs();
	const git = createGit({ attributes: gitAttributes({ filters: secretFilters }) });
	const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
	await bash.writeFile("/repo/.gitattributes", "*.conf filter=secret\n");
	await bash.writeFile("/repo/app.conf", "SECRET=hunter2\n");
	await bash.writeFile("/repo/notes.txt", "SECRET=hunter2\n");
	await bash.writeFile("/repo/sub/.gitattributes", "*.conf -filter\n");
	await bash.writeFile("/repo/sub/keep.conf", "SECRET=hunter2\n");
	await bash.exec("git init", { env: TEST_ENV });
	await bash.exec("git add .", { env: TEST_ENV });
	await bash.exec('git commit -m "init"', { env: TEST_ENV });

	const bare = (await findRepo(fs, "/repo"))!;
	const treeHash = (await readCommit(bare, await getRefHash(bare, "HEAD"))).tree;
	return { bare, treeHash };
}

function withSecret(repo: GitRepo): GitRepo {
	return withCapabilities(repo, { attributes: gitAttributes({ filters: secretFilters }) });
}

describe("tree attributes provider", () => {
	test("resolves filter= from the committed tree, deepest .gitattributes wins", async () => {
		const { bare, treeHash } = await setupTree();
		const p = createTreeAttributesProvider(bare.objectStore, treeHash);

		expect(await p.get("app.conf", "filter")).toBe("secret");
		// sub/.gitattributes unsets the filter for *.conf below it.
		expect(await p.get("sub/keep.conf", "filter")).toBe(false);
		// .txt has no rule.
		expect(await p.get("notes.txt", "filter")).toBeUndefined();
	});

	test("getAll collects decided attributes for a path", async () => {
		const { bare, treeHash } = await setupTree();
		const p = createTreeAttributesProvider(bare.objectStore, treeHash);
		expect(await p.getAll("app.conf")).toEqual(new Map([["filter", "secret"]]));
		expect(await p.getAll("notes.txt")).toEqual(new Map());
	});
});

describe("materialize — smudge (Seam B)", () => {
	test("materialize smudges blobs when the attributes capability is attached", async () => {
		const { bare, treeHash } = await setupTree();
		const tree = createTreeAccessor(withSecret(bare), treeHash);

		const out = new InMemoryFs();
		await tree.materialize(out, "/");

		// app.conf: stored redacted → smudged back to the worktree form.
		expect(await out.readFile("/app.conf")).toBe("SECRET=hunter2\n");
		// notes.txt: no filter attribute → stored verbatim, untouched.
		expect(await out.readFile("/notes.txt")).toBe("SECRET=hunter2\n");
	});

	test("materialize emits raw stored bytes when no capability is attached", async () => {
		const { bare, treeHash } = await setupTree();
		const tree = createTreeAccessor(bare, treeHash);

		const out = new InMemoryFs();
		await tree.materialize(out, "/");

		// No smudge: the redacted stored blob is written as-is.
		expect(await out.readFile("/app.conf")).toBe("SECRET=__REDACTED__\n");
	});
});

describe("TreeBackedFs — lazy smudge (Seam B)", () => {
	test("readFile / readFileBytes smudge when the capability is attached", async () => {
		const { bare, treeHash } = await setupTree();
		const tree = createTreeAccessor(withSecret(bare), treeHash);

		expect(await tree.readFile("app.conf")).toBe("SECRET=hunter2\n");
		expect(await tree.readFileBytes("app.conf")).toEqual(enc.encode("SECRET=hunter2\n"));
	});

	test("lazy reads stay raw when no capability is attached", async () => {
		const { bare, treeHash } = await setupTree();
		const tree = createTreeAccessor(bare, treeHash);

		expect(await tree.readFile("app.conf")).toBe("SECRET=__REDACTED__\n");
	});
});
