import { resolveWorktreeRoot } from "../../../random/file-gen";
import type { WorkTreeFile } from "../../capture";
import { color, indent } from "./format";

/** VFS root the virtual replay materializes the primary worktree at. */
const CLI_VFS_ROOT = "/repo";

/**
 * Resolve a worktree key (default "main" = primary) to the checkout dir on each
 * replayed side. Linked worktrees are keyed by their normalized anchor-relative
 * path (e.g. `wt-x`, `sub/wt-x`) — exactly what the `worktree:<path>:` divergence
 * fields name. The checkout sits at `../<path>` relative to the repo root on
 * both the real temp tree and the VFS. For "main" the dirs are the replay roots.
 */
export function resolveWorktreeDirs(
	repoDir: string,
	worktreePath: string,
): { realDir: string; vfsDir: string } {
	if (worktreePath === "main") return { realDir: repoDir, vfsDir: CLI_VFS_ROOT };
	const selector = `../${worktreePath}`;
	return {
		realDir: resolveWorktreeRoot(repoDir, selector),
		vfsDir: resolveWorktreeRoot(CLI_VFS_ROOT, selector),
	};
}

interface WorkTreeDiffEntry {
	path: string;
	oracleLen: number;
	implLen: number;
	oracleSha: string;
	implSha: string;
}

export function diffWorkTrees(
	oracleFiles: WorkTreeFile[],
	implFiles: { path: string; content: string }[],
): { differing: WorkTreeDiffEntry[] } {
	const oracle = new Map(oracleFiles.map((f) => [f.path, f.content]));
	const impl = new Map(implFiles.map((f) => [f.path, f.content]));
	const allPaths = new Set<string>([...oracle.keys(), ...impl.keys()]);
	const differing: WorkTreeDiffEntry[] = [];

	for (const path of [...allPaths].sort()) {
		const a = oracle.get(path);
		const b = impl.get(path);
		if (a === b) continue;
		differing.push({
			path,
			oracleLen: a?.length ?? -1,
			implLen: b?.length ?? -1,
			oracleSha: a == null ? "(missing)" : sha1Hex(a),
			implSha: b == null ? "(missing)" : sha1Hex(b),
		});
	}

	return { differing };
}

function sha1Hex(text: string): string {
	const h = new Bun.CryptoHasher("sha1");
	h.update(text);
	return h.digest("hex");
}

export function printFirstMismatch(path: string, oracle: string, impl: string): void {
	const oracleLines = oracle.split("\n");
	const implLines = impl.split("\n");
	let oi = 0;
	let ii = 0;
	while (oi < oracleLines.length || ii < implLines.length) {
		if (oracleLines[oi] === implLines[ii]) {
			oi++;
			ii++;
			continue;
		}

		console.log(`First mismatch in ${path}: oracle line ${oi + 1}, impl line ${ii + 1}\n`);
		for (let k = Math.max(0, oi - 4); k < Math.min(oracleLines.length, oi + 12); k++) {
			console.log(`  O ${String(k + 1).padStart(4)} ${oracleLines[k]}`);
		}
		console.log("");
		for (let k = Math.max(0, ii - 4); k < Math.min(implLines.length, ii + 12); k++) {
			console.log(`  I ${String(k + 1).padStart(4)} ${implLines[k]}`);
		}
		console.log("");
		return;
	}
}

export async function readRealStageBlob(
	repoDir: string,
	path: string,
	stage: number,
): Promise<string> {
	const expr = `:${stage}:${path}`;
	const proc = Bun.spawn(["git", "show", expr], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return stdout;
}

export function printStageBlob(
	prefix: string,
	stage: number,
	sha: string,
	mode: number,
	content: string,
	full: boolean,
): void {
	console.log(
		`${prefix}stage ${stage}: sha=${sha} mode=${mode.toString(8)} len=${content.length} contentSha=${sha1Hex(content)}`,
	);
	if (full) {
		console.log(`${prefix}${indent(content, "")}`);
	} else {
		const preview = content.slice(0, 300);
		if (preview.length > 0) {
			console.log(`${prefix}preview: ${JSON.stringify(preview)}`);
		}
	}
}

interface StateSummary {
	headRef: string | null;
	headSha: string | null;
	operation: string | null;
	operationHash: string | null;
	refCount: number;
	indexCount: number;
	conflictCount: number;
	workTreeHash: string;
}

export function printState(s: StateSummary): void {
	console.log(`  HEAD: ${s.headRef ?? "(detached)"} -> ${s.headSha ?? "(none)"}`);
	console.log(
		`  Operation: ${s.operation ?? "none"}${s.operationHash ? ` (${s.operationHash.slice(0, 12)}...)` : ""}`,
	);
	console.log(
		`  Refs: ${s.refCount}  Index: ${s.indexCount}${s.conflictCount > 0 ? ` + ${s.conflictCount} conflict` : ""}`,
	);
	console.log(`  Worktree: ${s.workTreeHash}`);
}

/**
 * Print a comparison of oracle vs impl output for a single stream (stdout/stderr).
 * Shows MATCH/MISMATCH with character-level first-difference on mismatch.
 */
export function printOutputComparison(label: string, oracle: string, impl: string): void {
	console.log(`\n=== ${label} ===`);
	if (oracle === impl) {
		console.log(color.green("MATCH"));
		if (oracle) {
			console.log(color.dim("Content:"));
			console.log(indent(oracle));
		} else {
			console.log(color.dim("(empty)"));
		}
	} else {
		console.log(color.red("MISMATCH"));
		console.log(`\n${color.yellow(`Oracle ${label.toLowerCase()}:`)}`);
		console.log(oracle || color.dim("(empty)"));
		console.log(`\n${color.yellow(`Impl ${label.toLowerCase()}:`)}`);
		console.log(impl || color.dim("(empty)"));

		// Character-level first difference
		const maxLen = Math.max(oracle.length, impl.length);
		for (let i = 0; i < maxLen; i++) {
			if (oracle[i] !== impl[i]) {
				console.log(
					`\nFirst diff at char ${i}: oracle=${JSON.stringify(oracle[i] ?? "(end)")} impl=${JSON.stringify(impl[i] ?? "(end)")}`,
				);
				const start = Math.max(0, i - 20);
				console.log(
					`  oracle[${start}..${i + 20}]: ${JSON.stringify(oracle.slice(start, i + 20))}`,
				);
				console.log(`  impl  [${start}..${i + 20}]: ${JSON.stringify(impl.slice(start, i + 20))}`);
				break;
			}
		}
	}
}
