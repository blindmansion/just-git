import type { GitExtensions } from "../git.ts";
import { err, isCommandError, requireGitContext } from "../lib/command-utils.ts";
import {
	type GitConfig,
	getConfigValue,
	readConfig,
	setConfigValue,
	unsetConfigValue,
} from "../lib/config.ts";
import { a, type Command, f } from "../parse/index.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function isValidDottedKey(key: string): boolean {
	const parts = key.split(".");
	return parts.length === 2 || parts.length === 3;
}

/**
 * Flatten a GitConfig into `key=value` lines for `--list` / `list` output.
 * Two-part sections → `section.key`, subsection sections → `section.subsection.key`.
 */
function flattenConfig(config: GitConfig): string[] {
	const lines: string[] = [];
	for (const [section, entries] of Object.entries(config)) {
		const match = section.match(/^(\S+)\s+"(.+)"$/);
		for (const [key, value] of Object.entries(entries)) {
			const dottedKey = match ? `${match[1]}.${match[2]}.${key}` : `${section}.${key}`;
			lines.push(`${dottedKey}=${value}`);
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
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const positionals = args.positionals;
			const first = positionals[0] as string | undefined;

			// ── Flag-based operations (legacy syntax) ────────────────
			if (args.list) {
				return handleList(await readConfig(gitCtx));
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
				return handleList(await readConfig(gitCtx));
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

function handleList(config: GitConfig): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	const lines = flattenConfig(config);
	return {
		stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
		stderr: "",
		exitCode: 0,
	};
}
