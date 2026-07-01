import { existsSync, readdirSync, statSync } from "fs";
import { DATA_DIR } from "./shared/args";
import { dirname, join } from "path";
import { color } from "./shared/format";

/** True if `name` under DATA_DIR is a directory, following symlinks. */
function isDatasetDir(name: string): boolean {
	try {
		return statSync(join(DATA_DIR, name)).isDirectory();
	} catch {
		return false;
	}
}

// The entry point that dispatches subcommands lives one level up at cli.ts.
const CLI_ENTRY = join(dirname(import.meta.path), "..", "cli.ts");

export async function cmdTestAll(args: string[]): Promise<void> {
	const passthrough = args.filter(
		(a) => a === "-v" || a === "--verbose" || a === "--no-post-mortem",
	);

	let dirs: string[];
	try {
		dirs = readdirSync(DATA_DIR).filter(isDatasetDir).sort();
	} catch {
		console.log(`No data directory found at ${DATA_DIR}`);
		process.exit(1);
	}

	const sets = dirs.filter((d) => existsSync(join(DATA_DIR, d, "traces.sqlite")));

	if (sets.length === 0) {
		console.log("No datasets with traces.sqlite found.");
		process.exit(1);
	}

	console.log(`Testing ${sets.length} dataset${sets.length !== 1 ? "s" : ""}:\n`);
	let anyFailed = false;

	for (const name of sets) {
		console.log(`${"═".repeat(60)}`);
		console.log(`  ${name}`);
		console.log(`${"═".repeat(60)}\n`);

		const proc = Bun.spawn(["bun", CLI_ENTRY, "test", name, ...passthrough], {
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code !== 0) anyFailed = true;
		console.log("");
	}

	console.log(`Done. Run ${color.dim("bun oracle summary")} for aggregate results.`);
	if (anyFailed) process.exit(1);
}
