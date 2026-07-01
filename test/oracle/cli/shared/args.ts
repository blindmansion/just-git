import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// This file lives at test/oracle/cli/shared/, so data/ is two levels up.
export const DATA_DIR = join(dirname(import.meta.path), "..", "..", "data");

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
	return join(DATA_DIR, name, "traces.sqlite");
}

export function ensureDbDir(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}
