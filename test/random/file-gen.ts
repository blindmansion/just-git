/**
 * Shared file operation batch generation.
 *
 * The core function `generateAndApplyFileOps` is the single source of truth
 * for file-op batches. Given the same seed and the same file list, it produces
 * identical operations on any FileOpTarget — real FS, virtual FS, or anything
 * else that satisfies the interface.
 *
 * Stored in traces as `FILE_BATCH:<seed>`. Regenerated at replay time.
 */

import { SeededRNG } from "./rng";

// ── File generation config ───────────────────────────────────────────

/** Controls gitignore file generation within file-op batches. */
export interface GitignoreConfig {
	/** Probability per batch of generating a gitignore operation. */
	rate: number;
	/** Probability of placing in a subdirectory vs root. */
	subdirRate: number;
	/** Pool of patterns to pick from. */
	patterns: string[];
}

export const DEFAULT_GITIGNORE_PATTERNS = [
	"*.log",
	"*.tmp",
	"build/",
	"dist/",
	"node_modules/",
	"*.o",
	".env",
	"*.bak",
	"temp/",
	"*.swp",
	"coverage/",
	"*.pyc",
	"__pycache__/",
	".cache/",
];

/** Controls all aspects of random file generation. */
export interface FileGenConfig {
	/** Lines when creating a new file [min, max]. */
	newFileLines: [number, number];
	/** Lines when splicing in edits [min, max]. */
	editLines: [number, number];
	/** Characters per line [min, max]. */
	lineLength: [number, number];
	/** Batch size range [min, max]. */
	batchSize: [number, number];
	/** Directory prefixes for new file paths. */
	dirPrefixes: string[];
	/** Probability of generating an empty file (0-1). */
	emptyFileRate: number;
	/** Edit strategy weights: [edit, create, delete]. Normalized internally. */
	editWeights: [number, number, number];
	/** Optional gitignore generation config. Off by default. */
	gitignore?: GitignoreConfig;
}

export const DEFAULT_FILE_GEN_CONFIG: FileGenConfig = {
	newFileLines: [15, 80],
	editLines: [3, 12],
	lineLength: [20, 60],
	batchSize: [3, 10],
	dirPrefixes: ["", "src/", "lib/", "docs/", "test/", "src/util/"],
	emptyFileRate: 0,
	editWeights: [40, 45, 15],
};

/** Wider content space: deeper nesting, occasional large files, some empties. */
export const WIDE_FILE_GEN_CONFIG: FileGenConfig = {
	newFileLines: [15, 120],
	editLines: [3, 16],
	lineLength: [20, 80],
	batchSize: [3, 12],
	dirPrefixes: ["", "src/", "lib/", "docs/", "test/", "src/util/", "a/b/c/", "src/components/ui/"],
	emptyFileRate: 0.05,
	editWeights: [35, 45, 20],
};

/** Stress config: large batches, big files, many directories, few deletes. */
export const STRESS_FILE_GEN_CONFIG: FileGenConfig = {
	newFileLines: [40, 250],
	editLines: [5, 30],
	lineLength: [30, 100],
	batchSize: [8, 25],
	dirPrefixes: [
		"",
		"src/",
		"src/core/",
		"src/util/",
		"src/components/",
		"src/components/ui/",
		"src/services/",
		"lib/",
		"lib/internal/",
		"docs/",
		"docs/api/",
		"test/",
		"test/unit/",
		"test/integration/",
		"config/",
		"scripts/",
	],
	emptyFileRate: 0,
	editWeights: [30, 60, 10],
};

// ── FileOpTarget ─────────────────────────────────────────────────────

/** Minimal interface for applying file operations to a filesystem. */
export interface FileOpTarget {
	writeFile(relPath: string, content: string): Promise<void>;
	readFile(relPath: string): Promise<string>;
	spliceFile(relPath: string, content: string, offset: number, deleteCount: number): Promise<void>;
	deleteFile(relPath: string): Promise<void>;
}

// ── Content helpers ──────────────────────────────────────────────────

/** Check if a path is a .gitignore file. */
function isGitignore(path: string): boolean {
	return path === ".gitignore" || path.endsWith("/.gitignore");
}

/** Generate a random file path (never generates .gitignore). */
function randomFilePath(rng: SeededRNG, cfg: FileGenConfig = DEFAULT_FILE_GEN_CONFIG): string {
	const prefix = rng.pick(cfg.dirPrefixes);
	const name = rng.alphanumeric(rng.int(3, 8));
	const ext = rng.pick([".txt", ".ts", ".md", ".json"]);
	return `${prefix}${name}${ext}`;
}

/** Generate random file content. ~15% chance of no trailing newline. */
export function randomContent(
	rng: SeededRNG,
	cfg: FileGenConfig = DEFAULT_FILE_GEN_CONFIG,
): string {
	if (cfg.emptyFileRate > 0 && rng.next() < cfg.emptyFileRate) {
		return "";
	}
	const lineCount = rng.int(cfg.newFileLines[0], cfg.newFileLines[1]);
	const lines: string[] = [];
	for (let i = 0; i < lineCount; i++) {
		lines.push(rng.alphanumeric(rng.int(cfg.lineLength[0], cfg.lineLength[1])));
	}
	const trailing = rng.bool(0.85) ? "\n" : "";
	return `${lines.join("\n")}${trailing}`;
}

/**
 * Find all line-boundary byte offsets in a string.
 * offsets[i] is the byte offset of line i; last entry is total length.
 */
function lineBoundaries(content: string): number[] {
	const offsets = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") {
			offsets.push(i + 1);
		}
	}
	if (offsets[offsets.length - 1] !== content.length) {
		offsets.push(content.length);
	}
	return offsets;
}

/** Random lines of content for edits. Always newline-terminated. */
function randomLines(rng: SeededRNG, cfg: FileGenConfig): string {
	const count = rng.int(cfg.editLines[0], cfg.editLines[1]);
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		lines.push(rng.alphanumeric(rng.int(cfg.lineLength[0], cfg.lineLength[1])));
	}
	return `${lines.join("\n")}\n`;
}

// ── Batch generation ─────────────────────────────────────────────────

/**
 * Generate and apply a batch of random file operations.
 *
 * Deterministic: same (seed, files, cfg) → same operations.
 * The `files` array should be the sorted worktree file list at the time
 * of invocation. It is NOT mutated; an internal copy tracks changes.
 *
 * Returns description strings for logging/debugging.
 */
export async function generateAndApplyFileOps(
	target: FileOpTarget,
	seed: number,
	files: string[],
	cfg: FileGenConfig = DEFAULT_FILE_GEN_CONFIG,
): Promise<string[]> {
	const rng = new SeededRNG(seed);
	const count = rng.int(cfg.batchSize[0], cfg.batchSize[1]);
	const descriptions: string[] = [];
	const currentFiles = [...files]; // mutable working copy

	for (let i = 0; i < count; i++) {
		const desc = await applyOneOp(target, rng, currentFiles, cfg);
		descriptions.push(desc);
	}

	// Gitignore generation: occasionally create/update a .gitignore file
	if (cfg.gitignore && rng.next() < cfg.gitignore.rate) {
		const desc = await applyGitignoreOp(target, rng, currentFiles, cfg.gitignore, cfg.dirPrefixes);
		descriptions.push(desc);
	}

	return descriptions;
}

/**
 * Pick and apply a single random file operation.
 * Mutates `files` to reflect creates/deletes.
 */
async function applyOneOp(
	target: FileOpTarget,
	rng: SeededRNG,
	files: string[],
	cfg: FileGenConfig,
): Promise<string> {
	// If few files, always create
	if (files.length < 2) {
		return applyCreate(target, rng, files, cfg);
	}

	// Weighted pick using editWeights: [edit, create, delete]
	const [editW, createW, deleteW] = cfg.editWeights;
	const total = editW + createW + deleteW;
	const roll = rng.next() * total;
	if (roll < editW) {
		return applyEdit(target, rng, files, cfg);
	}
	if (roll < editW + createW) {
		return applyCreate(target, rng, files, cfg);
	}
	// delete (but keep at least 1 file)
	if (files.length > 1) {
		return applyDelete(target, rng, files);
	}
	return applyCreate(target, rng, files, cfg);
}

async function applyCreate(
	target: FileOpTarget,
	rng: SeededRNG,
	files: string[],
	cfg: FileGenConfig,
): Promise<string> {
	const path = randomFilePath(rng, cfg);
	const content = randomContent(rng, cfg);
	await target.writeFile(path, content);
	if (!files.includes(path)) {
		files.push(path);
		files.sort();
	}
	return `write ${path}`;
}

async function applyEdit(
	target: FileOpTarget,
	rng: SeededRNG,
	files: string[],
	cfg: FileGenConfig,
): Promise<string> {
	let path = rng.pick(files);

	// Don't edit .gitignore files via normal edits (gitignore ops are separate)
	if (isGitignore(path)) {
		const nonIgnore = files.filter((f) => !isGitignore(f));
		if (nonIgnore.length === 0) return applyCreate(target, rng, files, cfg);
		path = rng.pick(nonIgnore);
	}

	let content: string;
	try {
		content = await target.readFile(path);
	} catch {
		const newContent = randomContent(rng, cfg);
		await target.writeFile(path, newContent);
		return `edit ${path} (overwrite, read failed)`;
	}

	const bounds = lineBoundaries(content);
	const lineCount = bounds.length - 1;

	type Strategy = { name: string; weight: number };
	const strategies: Strategy[] = [
		{ name: "overwrite", weight: Math.max(1, 6 - lineCount) },
		{ name: "append", weight: 4 },
		{ name: "prepend", weight: 3 },
	];
	if (lineCount >= 2) {
		strategies.push({ name: "insert", weight: Math.min(lineCount, 6) });
		strategies.push({ name: "replace", weight: Math.min(lineCount, 5) });
	}
	if (lineCount >= 3) {
		strategies.push({ name: "delete", weight: Math.min(lineCount, 4) });
	}

	const picked = rng.pickWeighted(strategies.map((s) => ({ value: s.name, weight: s.weight })));

	switch (picked) {
		case "overwrite": {
			const newContent = randomContent(rng, cfg);
			await target.writeFile(path, newContent);
			return `edit ${path} (overwrite)`;
		}
		case "append": {
			const insert = randomLines(rng, cfg);
			await target.spliceFile(path, insert, content.length, 0);
			return `edit ${path} (append)`;
		}
		case "prepend": {
			const insert = randomLines(rng, cfg);
			await target.spliceFile(path, insert, 0, 0);
			return `edit ${path} (prepend)`;
		}
		case "insert": {
			const lineIdx = rng.int(1, lineCount - 1);
			const offset = bounds[lineIdx];
			const insert = randomLines(rng, cfg);
			await target.spliceFile(path, insert, offset, 0);
			return `edit ${path} (insert at line ${lineIdx})`;
		}
		case "delete": {
			const maxDel = Math.min(3, lineCount - 1);
			const delCount = rng.int(1, maxDel);
			const startLine = rng.int(0, lineCount - delCount);
			const offset = bounds[startLine];
			const endOffset = bounds[startLine + delCount];
			await target.spliceFile(path, "", offset, endOffset - offset);
			return `edit ${path} (delete ${delCount} lines)`;
		}
		case "replace": {
			const maxRepl = Math.min(3, lineCount);
			const replCount = rng.int(1, maxRepl);
			const startLine = rng.int(0, lineCount - replCount);
			const offset = bounds[startLine];
			const endOffset = bounds[startLine + replCount];
			const replacement = randomLines(rng, cfg);
			await target.spliceFile(path, replacement, offset, endOffset - offset);
			return `edit ${path} (replace ${replCount} lines)`;
		}
		default: {
			const newContent = randomContent(rng, cfg);
			await target.writeFile(path, newContent);
			return `edit ${path} (overwrite)`;
		}
	}
}

/**
 * Resolve all working tree files with random content (for conflict resolution).
 *
 * Deterministic: same (seed, files, cfg) → same content written.
 * `files` should be the sorted worktree file list at the time of invocation.
 *
 * Stored in traces as `FILE_RESOLVE:<seed>`. Regenerated at replay time.
 */
export async function resolveAllFiles(
	target: FileOpTarget,
	seed: number,
	files: string[],
	cfg: FileGenConfig = DEFAULT_FILE_GEN_CONFIG,
): Promise<void> {
	const rng = new SeededRNG(seed);
	const sorted = [...files].sort();
	for (const file of sorted) {
		const content = randomContent(rng, cfg);
		await target.writeFile(file, content);
	}
}

/**
 * Create or update a .gitignore file with random patterns.
 * Placed at root or in a subdirectory depending on subdirRate.
 */
async function applyGitignoreOp(
	target: FileOpTarget,
	rng: SeededRNG,
	files: string[],
	gitCfg: GitignoreConfig,
	dirPrefixes: string[],
): Promise<string> {
	// Decide location: root or subdirectory
	const inSubdir = rng.next() < gitCfg.subdirRate;
	let dir = "";
	if (inSubdir && dirPrefixes.length > 1) {
		const nonRoot = dirPrefixes.filter((d) => d !== "");
		if (nonRoot.length > 0) {
			dir = rng.pick(nonRoot);
		}
	}
	const ignorePath = `${dir}.gitignore`;

	// Pick 1-5 patterns from the pool
	const patternCount = rng.int(1, Math.min(5, gitCfg.patterns.length));
	const shuffled = [...gitCfg.patterns].sort(() => rng.next() - 0.5);
	const chosen = shuffled.slice(0, patternCount);

	// Check if .gitignore already exists and decide: overwrite or append
	const existingIdx = files.indexOf(ignorePath);
	if (existingIdx >= 0 && rng.bool(0.6)) {
		// Append to existing
		try {
			const existing = await target.readFile(ignorePath);
			const newContent = `${existing.trimEnd()}\n${chosen.join("\n")}\n`;
			await target.writeFile(ignorePath, newContent);
			return `gitignore ${ignorePath} (append ${patternCount} patterns)`;
		} catch {
			// Fall through to overwrite
		}
	}

	// Create/overwrite
	const content = `${chosen.join("\n")}\n`;
	await target.writeFile(ignorePath, content);
	if (!files.includes(ignorePath)) {
		files.push(ignorePath);
		files.sort();
	}
	return `gitignore ${ignorePath} (${patternCount} patterns)`;
}

async function applyDelete(target: FileOpTarget, rng: SeededRNG, files: string[]): Promise<string> {
	const path = rng.pick(files);
	await target.deleteFile(path);
	const idx = files.indexOf(path);
	if (idx >= 0) files.splice(idx, 1);
	return `delete ${path}`;
}

// ── Server-side commit file generation ───────────────────────────────

/**
 * Generate a deterministic set of files for a server-side commit.
 * Returns a map of path → content suitable for `server.commit()`.
 */
export function generateServerCommitFiles(
	seed: number,
	cfg: FileGenConfig = DEFAULT_FILE_GEN_CONFIG,
): Record<string, string> {
	const rng = new SeededRNG(seed);
	const fileCount = rng.int(1, 5);
	const files: Record<string, string> = {};
	for (let i = 0; i < fileCount; i++) {
		const path = randomFilePath(rng, cfg);
		files[path] = randomContent(rng, cfg);
	}
	return files;
}
