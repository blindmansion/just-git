/**
 * Measures bundle sizes of the published entry points.
 *
 * For each public subpath export we bundle the whole module surface
 * (minified) and report raw + gzip. We also bundle a few single-function
 * imports from `just-git/repo` to show that tree-shaking works at the
 * function level — consumers only pay for what they import.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = new URL("..", import.meta.url).pathname;
const TMP = mkdtempSync(join(tmpdir(), "just-git-size-"));

interface Target {
	label: string;
	source: string;
}

const modules: Target[] = [
	{ label: "just-git (client)", source: `${ROOT}dist/index.js` },
	{ label: "just-git/server", source: `${ROOT}dist/server/index.js` },
	{ label: "just-git/repo", source: `${ROOT}dist/repo/index.js` },
	{ label: "just-git/store", source: `${ROOT}dist/store/index.js` },
	{ label: "just-git/proxy", source: `${ROOT}dist/proxy/index.js` },
];

// A few representative single-function imports to demonstrate tree-shaking.
const repoSamples = ["readBlob", "commit", "diffCommits", "merge", "cloneInto"];

let entryCounter = 0;
async function bundleSize(entryContents: string): Promise<{ raw: number; gz: number }> {
	const entry = join(TMP, `entry-${entryCounter++}.ts`);
	writeFileSync(entry, entryContents);
	const result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		minify: true,
	});
	if (!result.success) {
		throw new AggregateError(result.logs, "bundle failed");
	}
	const code = await result.outputs[0]!.text();
	const bytes = Buffer.from(code);
	return { raw: bytes.length, gz: gzipSync(bytes).length };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

async function main() {
	console.log("Whole-module bundle size (minified):\n");
	console.log(pad("module", 22), padL("raw", 10), padL("gzip", 10));
	console.log("-".repeat(44));
	for (const m of modules) {
		const { raw, gz } = await bundleSize(`export * from ${JSON.stringify(m.source)};`);
		console.log(pad(m.label, 22), padL(kb(raw), 10), padL(kb(gz), 10));
	}

	console.log("\nSingle-function imports from just-git/repo (tree-shaking):\n");
	console.log(pad("import", 22), padL("raw", 10), padL("gzip", 10));
	console.log("-".repeat(44));
	const repoEntry = `${ROOT}dist/repo/index.js`;
	for (const fn of repoSamples) {
		const { raw, gz } = await bundleSize(`export { ${fn} } from ${JSON.stringify(repoEntry)};`);
		console.log(pad(`{ ${fn} }`, 22), padL(kb(raw), 10), padL(kb(gz), 10));
	}
}

await main();
rmSync(TMP, { recursive: true, force: true });
