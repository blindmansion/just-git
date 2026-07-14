import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// This file lives at test/oracle/cli/shared/, so data/ is two levels up.
export const DATA_DIR = join(dirname(import.meta.path), "..", "..", "data");

export type DatasetMarker = "traces.sqlite" | "test-results.log";

/**
 * Resolve a dataset or grouping path beneath an oracle data directory.
 *
 * Paths use forward slashes so IDs are stable across platforms. Symlinks below
 * the data directory remain supported, but lexical traversal outside it does not.
 */
export function datasetDir(path: string, dataDir = DATA_DIR): string {
	const segments = path.split("/");
	if (
		!path ||
		isAbsolute(path) ||
		path.includes("\\") ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error(
			`Invalid oracle dataset path "${path}": expected a relative path such as "group/name"`,
		);
	}

	const root = resolve(dataDir);
	const resolved = resolve(root, ...segments);
	const fromRoot = relative(root, resolved);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new Error(`Oracle dataset path escapes data directory: "${path}"`);
	}
	return resolved;
}

/**
 * Find dataset leaves recursively. A directory is a dataset when it directly
 * contains `marker`; traversal stops there.
 *
 * Directory symlinks are followed for compatibility with existing oracle data.
 * Only ancestor real paths are tracked, so two aliases to the same dataset are
 * still reported while symlink cycles are ignored.
 */
export function discoverDatasets(
	marker: DatasetMarker,
	prefix?: string,
	dataDir = DATA_DIR,
): string[] {
	const root = resolve(dataDir);
	const start = prefix ? datasetDir(prefix, root) : root;
	if (!existsSync(start)) return [];

	const datasets: string[] = [];

	function visit(dir: string, ancestors: Set<string>): void {
		let realDir: string;
		try {
			if (!statSync(dir).isDirectory()) return;
			realDir = realpathSync(dir);
		} catch {
			return;
		}
		if (ancestors.has(realDir)) return;

		const id = relative(root, dir).split(sep).join("/");
		if (id && existsSync(join(dir, marker))) {
			datasets.push(id);
			return;
		}

		const nextAncestors = new Set(ancestors);
		nextAncestors.add(realDir);
		for (const entry of readdirSync(dir).sort()) {
			visit(join(dir, entry), nextAncestors);
		}
	}

	visit(start, new Set());
	return datasets.sort();
}

// ── Arg helpers ──────────────────────────────────────────────────

/** Known flags that consume the next arg as a value. */
const VALUE_FLAGS = new Set([
	"--seeds",
	"--steps",
	"--preset",
	"--description",
	"--db",
	"--trace",
	"--step",
	"--stop-at",
	"--before",
	"--limit",
	"--chaos",
	"--clone-url",
	"--top",
	"--every",
	"--worktree",
]);

/**
 * Parse args into positional args and flags/options.
 * Positional args are anything not starting with "-" and not consumed
 * as a value by a preceding flag.
 */
export function parseArgs(args: string[]): {
	positional: string[];
	getOpt: (name: string) => string | undefined;
	hasFlag: (name: string) => boolean;
} {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg.startsWith("-")) {
			if (VALUE_FLAGS.has(arg) && i + 1 < args.length) {
				flags.set(arg, args[i + 1]);
				i += 2;
			} else {
				flags.set(arg, true);
				i++;
			}
		} else {
			positional.push(arg);
			i++;
		}
	}
	return {
		positional,
		getOpt: (name: string) => {
			const v = flags.get(name);
			return typeof v === "string" ? v : undefined;
		},
		hasFlag: (name: string) => flags.has(name),
	};
}

export function dbPath(name: string): string {
	return join(datasetDir(name), "traces.sqlite");
}

export function ensureDbDir(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}
