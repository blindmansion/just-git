import { readdir } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_PREFIXES = ["oracle-git-", "oracle-home-", "replay-git-", "replay-home-"];

export async function cmdClean(_args: string[]): Promise<void> {
	const tmp = tmpdir();
	const entries = await readdir(tmp);
	const stale = entries.filter((name) => TEMP_PREFIXES.some((p) => name.startsWith(p)));

	if (stale.length === 0) {
		console.log("No leftover oracle temp directories found.");
		return;
	}

	console.log(
		`Removing ${stale.length} temp director${stale.length === 1 ? "y" : "ies"} from ${tmp}:\n`,
	);
	for (const name of stale.sort()) {
		const full = join(tmp, name);
		await rm(full, { recursive: true, force: true });
		console.log(`  ${name}`);
	}
	console.log("\nDone.");
}
