import type { FileSystem } from "../fs/index.ts";
import { removeFile, replaceFile } from "../fs/durable-io.ts";
import { join, resolve } from "./path.ts";
import type { DirectRef, ObjectId, Ref, SymbolicRef } from "./types.ts";

const SYMBOLIC_PREFIX = "ref: ";
const OBJECT_ID = /^[0-9a-f]{40}$/;
const PSEUDO_REF = /^[A-Z][A-Z0-9_]*$/;

export interface RawFileRefEntry {
	name: string;
	ref: Ref;
}

/** Parse a loose ref file without resolving symbolic refs. */
export function parseLooseRef(raw: string): Ref {
	const value = raw.trim();
	if (value.startsWith(SYMBOLIC_PREFIX)) {
		return {
			type: "symbolic",
			target: value.slice(SYMBOLIC_PREFIX.length),
		} satisfies SymbolicRef;
	}
	return { type: "direct", hash: value } satisfies DirectRef;
}

/** Serialize a raw ref using Git's native loose-ref representation. */
export function serializeLooseRef(ref: Ref): string {
	return ref.type === "symbolic" ? `${SYMBOLIC_PREFIX}${ref.target}\n` : `${ref.hash}\n`;
}

/** Resolve a ref name under a repository directory, rejecting path escape. */
export function refPath(repoDir: string, name: string): string {
	if (
		name.length === 0 ||
		name.includes("\0") ||
		name.startsWith("/") ||
		name.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`invalid filesystem ref name: ${JSON.stringify(name)}`);
	}

	const root = resolve(repoDir);
	const path = resolve(root, name);
	const insideRoot = root === "/" ? path.startsWith("/") : path.startsWith(`${root}/`);
	if (!insideRoot) throw new Error(`ref path escapes repository: ${JSON.stringify(name)}`);
	return path;
}

/** Read the direct refs recorded in a native packed-refs file. */
export async function readPackedRefs(
	fs: FileSystem,
	repoDir: string,
): Promise<Map<string, ObjectId>> {
	const path = join(repoDir, "packed-refs");
	if (!(await fs.exists(path))) return new Map();

	const refs = new Map<string, ObjectId>();
	for (const line of (await fs.readFile(path)).split("\n")) {
		if (!line || line.startsWith("#") || line.startsWith("^")) continue;
		const spaceIdx = line.indexOf(" ");
		if (spaceIdx === -1) continue;
		const hash = line.slice(0, spaceIdx);
		const name = line.slice(spaceIdx + 1).trim();
		if (OBJECT_ID.test(hash) && name) refs.set(name, hash);
	}
	return refs;
}

/**
 * Remove one ref and its optional peeled line from packed-refs.
 *
 * Returns whether the file changed.
 */
export async function removePackedRef(
	fs: FileSystem,
	repoDir: string,
	name: string,
): Promise<boolean> {
	refPath(repoDir, name);
	const packedPath = join(repoDir, "packed-refs");
	if (!(await fs.exists(packedPath))) return false;

	const content = await fs.readFile(packedPath);
	const filtered: string[] = [];
	let removed = false;
	let skipPeeled = false;

	for (const line of content.split("\n")) {
		if (skipPeeled && line.startsWith("^")) {
			skipPeeled = false;
			continue;
		}
		skipPeeled = false;

		if (!line || line.startsWith("#")) {
			filtered.push(line);
			continue;
		}

		const spaceIdx = line.indexOf(" ");
		if (spaceIdx !== -1 && line.slice(spaceIdx + 1).trim() === name) {
			removed = true;
			skipPeeled = true;
			continue;
		}
		filtered.push(line);
	}

	if (!removed) return false;
	const hasRefs = filtered.some((line) => line && !line.startsWith("#") && !line.startsWith("^"));
	if (hasRefs) {
		await replaceFile(fs, packedPath, filtered.join("\n"));
	} else {
		await removeFile(fs, packedPath);
	}
	return true;
}

/** Walk loose ref files under a validated prefix, returning raw values. */
export async function walkLooseRefs(
	fs: FileSystem,
	repoDir: string,
	prefix: string,
): Promise<RawFileRefEntry[]> {
	const dir = refPath(repoDir, prefix);
	if (!(await fs.exists(dir))) return [];
	const results: RawFileRefEntry[] = [];
	await walk(fs, dir, prefix, results);
	return results;
}

/** List valid uppercase top-level pseudo-ref files such as HEAD and ORIG_HEAD. */
export async function listLoosePseudoRefs(
	fs: FileSystem,
	repoDir: string,
): Promise<RawFileRefEntry[]> {
	if (!(await fs.exists(repoDir))) return [];
	const results: RawFileRefEntry[] = [];
	for (const name of await fs.readdir(repoDir)) {
		if (!PSEUDO_REF.test(name)) continue;
		const path = refPath(repoDir, name);
		const stat = await fs.stat(path);
		if (stat.isFile) results.push({ name, ref: parseLooseRef(await fs.readFile(path)) });
	}
	return results;
}

async function walk(
	fs: FileSystem,
	dirPath: string,
	prefix: string,
	results: RawFileRefEntry[],
): Promise<void> {
	for (const entry of await fs.readdir(dirPath)) {
		const refName = `${prefix}/${entry}`;
		const fullPath = refPath(dirPath, entry);
		const stat = await fs.stat(fullPath);
		if (stat.isDirectory) {
			await walk(fs, fullPath, refName, results);
		} else if (stat.isFile) {
			results.push({ name: refName, ref: parseLooseRef(await fs.readFile(fullPath)) });
		}
	}
}
