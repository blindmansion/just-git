import { dirname, join } from "path";
import { color } from "./shared/format";
import { discoverDatasets, parseArgs } from "./shared/args";

// The entry point that dispatches subcommands lives one level up at cli.ts.
const CLI_ENTRY = join(dirname(import.meta.path), "..", "cli.ts");

export async function cmdTestAll(args: string[]): Promise<void> {
	const { positional } = parseArgs(args);
	const prefix = positional[0];
	const passthrough = args.filter(
		(a) => a === "-v" || a === "--verbose" || a === "--no-post-mortem",
	);

	const sets = discoverDatasets("traces.sqlite", prefix);

	if (sets.length === 0) {
		console.log(`No datasets with traces.sqlite found${prefix ? ` under ${prefix}` : ""}.`);
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

	console.log(
		`Done. Run ${color.dim(`bun oracle summary${prefix ? ` ${prefix}` : ""}`)} for aggregate results.`,
	);
	if (anyFailed) process.exit(1);
}
