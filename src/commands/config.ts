import type { GitExtensions } from "../git.ts";
import { err, isCommandError, requireGitContext } from "../lib/command-utils.ts";
import {
	type GitConfigMulti,
	addConfigValue,
	getConfigValue,
	getConfigValueAll,
	parseConfigMulti,
	setConfigValue,
	unsetConfigValue,
} from "../lib/config.ts";
import { join } from "../lib/path.ts";
import { a, type Command, f } from "../parse/index.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function isValidDottedKey(key: string): boolean {
	const parts = key.split(".");
	return parts.length === 2 || parts.length === 3;
}

/**
 * Flatten a GitConfigMulti into `key=value` lines for `--list` output.
 * Multi-value keys produce one line per value, matching real git.
 */
function flattenConfigMulti(config: GitConfigMulti): string[] {
	const lines: string[] = [];
	for (const [section, entries] of Object.entries(config)) {
		const match = section.match(/^(\S+)\s+"(.+)"$/);
		for (const [key, values] of Object.entries(entries)) {
			const dottedKey = match ? `${match[1]}.${match[2]}.${key}` : `${section}.${key}`;
			for (const value of values) {
				lines.push(`${dottedKey}=${value}`);
			}
		}
	}
	return lines;
}

// ── Command ─────────────────────────────────────────────────────────

export function registerConfigCommand(parent: Command, ext?: GitExtensions) {
	parent.command("config", {
		description: "Get and set repository options",
		args: [a.string().name("positionals").variadic().optional()],
		options: {
			list: f().alias("l").describe("List all config entries"),
			unset: f().describe("Remove a config key"),
			"get-all": f().describe("Get all values for a multi-valued key"),
			add: f().describe("Add a new line without altering existing values"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const positionals = args.positionals;
			const first = positionals[0] as string | undefined;

			// ── Flag-based operations (legacy syntax) ────────────────
			if (args.list) {
				return handleList(gitCtx);
			}

			if (args["get-all"]) {
				const key = first;
				if (!key) {
					return err("error: missing key", 2);
				}
				if (!isValidDottedKey(key)) {
					return err(`error: invalid key: ${key}`, 2);
				}
				return handleGetAll(gitCtx, key);
			}

			if (args.add) {
				const key = first;
				const value = positionals[1] as string | undefined;
				if (!key || value === undefined) {
					return err("error: missing key and/or value", 2);
				}
				if (!isValidDottedKey(key)) {
					return err(`error: invalid key: ${key}`, 2);
				}
				await addConfigValue(gitCtx, key, value);
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			if (args.unset) {
				const key = first;
				if (!key) {
					return err("error: missing key", 2);
				}
				if (!isValidDottedKey(key)) {
					return err(`error: invalid key: ${key}`, 2);
				}
				return handleUnset(gitCtx, key);
			}

			// ── Subcommand dispatch ──────────────────────────────────
			if (first === "list") {
				return handleList(gitCtx);
			}

			if (first === "get") {
				const key = positionals[1] as string | undefined;
				if (!key) {
					return err("error: missing key", 2);
				}
				if (!isValidDottedKey(key)) {
					return err(`error: invalid key: ${key}`, 2);
				}
				return handleGet(gitCtx, key);
			}

			if (first === "get-all") {
				const key = positionals[1] as string | undefined;
				if (!key) {
					return err("error: missing key", 2);
				}
				if (!isValidDottedKey(key)) {
					return err(`error: invalid key: ${key}`, 2);
				}
				return handleGetAll(gitCtx, key);
			}

			if (first === "set") {
				const key = positionals[1] as string | undefined;
				const value = positionals[2] as string | undefined;
				if (!key || value === undefined) {
					return err("error: missing key and/or value", 2);
				}
				if (!isValidDottedKey(key)) {
					return err(`error: invalid key: ${key}`, 2);
				}
				await setConfigValue(gitCtx, key, value);
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			if (first === "unset") {
				const key = positionals[1] as string | undefined;
				if (!key) {
					return err("error: missing key", 2);
				}
				if (!isValidDottedKey(key)) {
					return err(`error: invalid key: ${key}`, 2);
				}
				return handleUnset(gitCtx, key);
			}

			// ── Legacy positional syntax ─────────────────────────────
			if (!first) {
				return err("usage: git config [get|set|unset|list] [<key>] [<value>]", 2);
			}

			if (!isValidDottedKey(first)) {
				return err(`error: invalid key: ${first}`, 2);
			}

			const value = positionals[1] as string | undefined;
			if (value !== undefined) {
				await setConfigValue(gitCtx, first, value);
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			return handleGet(gitCtx, first);
		},
	});
}

// ── Handlers ────────────────────────────────────────────────────────

async function handleGet(
	gitCtx: Parameters<typeof getConfigValue>[0],
	key: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const value = await getConfigValue(gitCtx, key);
	if (value === undefined) {
		return err("");
	}
	return { stdout: `${value}\n`, stderr: "", exitCode: 0 };
}

async function handleGetAll(
	gitCtx: Parameters<typeof getConfigValueAll>[0],
	key: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const values = await getConfigValueAll(gitCtx, key);
	if (values.length === 0) {
		return err("");
	}
	return { stdout: `${values.join("\n")}\n`, stderr: "", exitCode: 0 };
}

async function handleUnset(
	gitCtx: Parameters<typeof unsetConfigValue>[0],
	key: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const removed = await unsetConfigValue(gitCtx, key);
	if (!removed) {
		return err("", 5);
	}
	return { stdout: "", stderr: "", exitCode: 0 };
}

async function handleList(gitCtx: {
	gitDir: string;
	fs: { exists: (p: string) => Promise<boolean>; readFile: (p: string) => Promise<string> };
	configOverrides?: { locked?: Record<string, string>; defaults?: Record<string, string> };
}): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	const configPath = join(gitCtx.gitDir, "config");
	let raw = "";
	if (await gitCtx.fs.exists(configPath)) {
		raw = await gitCtx.fs.readFile(configPath);
	}
	const config = parseConfigMulti(raw);
	const lines = flattenConfigMulti(config);

	const seen = new Set(lines.map((l) => l.split("=")[0]!));
	const defaults = gitCtx.configOverrides?.defaults;
	if (defaults) {
		for (const [key, value] of Object.entries(defaults)) {
			if (!seen.has(key)) {
				lines.push(`${key}=${value}`);
				seen.add(key);
			}
		}
	}
	const locked = gitCtx.configOverrides?.locked;
	if (locked) {
		for (const [key, value] of Object.entries(locked)) {
			if (!seen.has(key)) {
				lines.push(`${key}=${value}`);
			}
		}
	}

	return {
		stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
		stderr: "",
		exitCode: 0,
	};
}
