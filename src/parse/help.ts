import { camelToKebab } from "./parser.ts";
import type { ArgDef, ArgsSchema, FlagDef, OptionDef, OptionsSchema } from "./types.ts";

// ============================================================================
// Structural type — avoids circular import with command.ts
// ============================================================================

interface HelpableCommand {
	readonly name: string;
	readonly fullPath: string;
	readonly description: string;
	readonly options: OptionsSchema;
	readonly args: ArgsSchema;
	readonly examples: readonly string[];
	readonly children: Map<string, HelpableCommand>;
	readonly handler?: unknown;
}

// ============================================================================
// Help text generation
// ============================================================================

/** Generate help text for any command node */
export function generateHelp(cmd: HelpableCommand): string {
	const lines: string[] = [];
	const hasSubcommands = cmd.children.size > 0;

	// Header
	if (cmd.description) {
		lines.push(`${cmd.fullPath} - ${cmd.description}`);
	} else {
		lines.push(cmd.fullPath);
	}
	lines.push("");

	// Usage line
	const usageParts = [cmd.fullPath];
	if (hasSubcommands) {
		usageParts.push("<command>");
	}
	if (Object.keys(cmd.options).length > 0) {
		usageParts.push("[options]");
	}
	const argDefs = cmd.args as readonly ArgDef<any>[];
	for (const argDef of argDefs) {
		const argName = argDef.name ?? "arg";
		const label = argDef.variadic ? `${argName}...` : argName;
		usageParts.push(argDef.required ? `<${label}>` : `[${label}]`);
	}

	lines.push("Usage:");
	lines.push(`  ${usageParts.join(" ")}`);
	lines.push("");

	// Subcommands
	if (hasSubcommands) {
		lines.push("Commands:");
		const entries: [string, string][] = [];
		for (const [name, child] of cmd.children) {
			entries.push([name, child.description || ""]);
		}
		const maxNameLen = Math.max(...entries.map(([name]) => name.length));
		for (const [name, desc] of entries) {
			if (desc) {
				const padding = " ".repeat(maxNameLen - name.length + 2);
				lines.push(`  ${name}${padding}${desc}`);
			} else {
				lines.push(`  ${name}`);
			}
		}
		lines.push("");
	}

	// Arguments
	if (argDefs.length > 0) {
		lines.push("Arguments:");
		const argRows: [string, string][] = [];
		for (const argDef of argDefs) {
			const rawName = argDef.name ?? "arg";
			const label = argDef.variadic ? `${rawName}...` : rawName;
			const parts: string[] = [];
			if (argDef.description) parts.push(argDef.description);
			if (argDef.required) parts.push("(required)");
			if (argDef.default !== undefined) {
				parts.push(`(default: ${JSON.stringify(argDef.default)})`);
			}
			argRows.push([label, parts.join(" ")]);
		}
		const maxLen = Math.max(...argRows.map(([label]) => label.length));
		for (const [label, desc] of argRows) {
			if (desc) {
				const padding = " ".repeat(maxLen - label.length + 2);
				lines.push(`  ${label}${padding}${desc}`);
			} else {
				lines.push(`  ${label}`);
			}
		}
		lines.push("");
	}

	// Own options
	const ownOptLines = formatOptionsTable(cmd.options);
	if (ownOptLines.length > 0) {
		lines.push("Options:");
		lines.push(...ownOptLines);
		lines.push("");
	}

	// Examples
	if (cmd.examples.length > 0) {
		lines.push("Examples:");
		for (const ex of cmd.examples) {
			lines.push(`  ${ex}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// Options table formatting
// ============================================================================

function formatOptionsTable(schema: OptionsSchema, header?: string): string[] {
	const entries = Object.entries(schema);
	if (entries.length === 0) return [];

	const rows: [string, string][] = [];

	for (const [key, def] of entries) {
		const longName = camelToKebab(key);

		if (def._kind === "flag") {
			const flag = def as FlagDef;
			const parts: string[] = [];
			if (flag.short) parts.push(`-${flag.short},`);
			parts.push(`--${longName}`);

			const descParts: string[] = [];
			if (flag.description) descParts.push(flag.description);
			if (flag.counted) descParts.push("(counted)");
			if (flag.default !== undefined) descParts.push(`(default: ${flag.default})`);

			rows.push([parts.join(" "), descParts.join(" ")]);
		} else {
			const opt = def as OptionDef<any>;
			const parts: string[] = [];
			if (opt.short) parts.push(`-${opt.short},`);
			parts.push(`--${longName} <${opt.type}>`);

			const descParts: string[] = [];
			if (opt.description) descParts.push(opt.description);
			if (opt.required) descParts.push("(required)");
			if (opt.default !== undefined) descParts.push(`(default: ${JSON.stringify(opt.default)})`);
			if (opt.env) descParts.push(`[env: ${opt.env}]`);

			rows.push([parts.join(" "), descParts.join(" ")]);
		}
	}

	const maxFlagLen = Math.max(...rows.map(([flag]) => flag.length));
	const lines: string[] = [];

	if (header) {
		lines.push(header);
	}

	for (const [flag, desc] of rows) {
		if (desc) {
			const padding = " ".repeat(maxFlagLen - flag.length + 2);
			lines.push(`  ${flag}${padding}${desc}`);
		} else {
			lines.push(`  ${flag}`);
		}
	}

	return lines;
}
