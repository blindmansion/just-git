// Generates a markdown file documenting the full CLI surface area
// by collecting --help output for every registered command.
//
// Usage: bun scripts/gen-cli-help.ts > docs/CLI.md

import { createGitCommand } from "../src/commands/git.ts";
import { generateHelp } from "../src/parse/help.ts";
import type { Command } from "../src/parse/index.ts";

const git = createGitCommand();

const lines: string[] = [];

lines.push("# CLI Reference");
lines.push("");
lines.push("Auto-generated from command definitions.");
lines.push("");

lines.push("## Top-level");
lines.push("");
lines.push("```");
lines.push(generateHelp(git).trimEnd());
lines.push("```");
lines.push("");

const sortedChildren = [...git.children.entries()].sort(([a], [b]) => a.localeCompare(b));

for (const [name, child] of sortedChildren) {
	lines.push(`## git ${name}`);
	lines.push("");
	lines.push("```");
	lines.push(generateHelp(child).trimEnd());
	lines.push("```");

	// If the child has subcommands (e.g. remote add/remove), list those too
	const grandchildren = child.children as Map<string, Command>;
	if (grandchildren.size > 0) {
		const sorted = [...grandchildren.entries()].sort(([a], [b]) => a.localeCompare(b));
		for (const [subName, grandchild] of sorted) {
			lines.push("");
			lines.push(`### git ${name} ${subName}`);
			lines.push("");
			lines.push("```");
			lines.push(generateHelp(grandchild).trimEnd());
			lines.push("```");
		}
	}

	lines.push("");
}

process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
