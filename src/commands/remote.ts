import type { CommandContext, GitExtensions } from "../git.ts";
import {
	type CommandResult,
	err,
	fatal,
	isCommandError,
	requireGitContext,
} from "../lib/command-utils.ts";
import { type GitConfig, readConfig, writeConfig } from "../lib/config.ts";
import { readReflog, writeReflog } from "../lib/reflog.ts";
import { checkRefFormat, deleteRef, listRefs, RefFormatFlag, updateRef } from "../lib/refs.ts";
import type { GitContext } from "../lib/types.ts";
import { a, type Command, f } from "../parse/index.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function getRemoteNames(config: GitConfig): string[] {
	const names: string[] = [];
	for (const section of Object.keys(config)) {
		const match = section.match(/^remote "(.+)"$/);
		if (match?.[1]) {
			names.push(match[1]);
		}
	}
	return names.sort();
}

// ── Command registration ────────────────────────────────────────────

export function registerRemoteCommand(parent: Command, ext?: GitExtensions) {
	const remote = parent.command("remote", {
		description: "Manage set of tracked repositories",
		options: {
			verbose: f().alias("v").describe("Show remote URLs"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;

			const config = await readConfig(gitCtxOrError);
			const names = getRemoteNames(config);
			if (names.length === 0) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			if (args.verbose) {
				const lines: string[] = [];
				for (const name of names) {
					const section = config[`remote "${name}"`];
					const url = section?.url ?? "";
					lines.push(`${name}\t${url} (fetch)`);
					lines.push(`${name}\t${url} (push)`);
				}
				return {
					stdout: `${lines.join("\n")}\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			return {
				stdout: `${names.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		},
	});

	remote.command("add", {
		description: "Add a remote named <name> for the repository at <url>",
		args: [
			a.string().name("name").describe("Remote name"),
			a.string().name("url").describe("Remote URL"),
		],
		handler: async (args, ctx) => {
			if (!checkRefFormat(`refs/remotes/${args.name}`, RefFormatFlag.NONE)) {
				return fatal(`'${args.name}' is not a valid remote name`);
			}

			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;

			const config = await readConfig(gitCtxOrError);
			const sectionKey = `remote "${args.name}"`;
			if (sectionKey in config) {
				return err(`error: remote ${args.name} already exists.\n`, 3);
			}

			config[sectionKey] = {
				url: args.url,
				fetch: `+refs/heads/*:refs/remotes/${args.name}/*`,
			};
			await writeConfig(gitCtxOrError, config);

			return { stdout: "", stderr: "", exitCode: 0 };
		},
	});

	const removeHandler = async (
		args: { name: string },
		ctx: CommandContext,
	): Promise<CommandResult> => {
		const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
		if (isCommandError(gitCtxOrError)) return gitCtxOrError;

		const config = await readConfig(gitCtxOrError);
		const sectionKey = `remote "${args.name}"`;
		if (!(sectionKey in config)) {
			return err(`error: No such remote: '${args.name}'\n`, 2);
		}

		delete config[sectionKey];
		cleanupBranchTrackingConfig(config, args.name);
		await writeConfig(gitCtxOrError, config);
		await cleanupTrackingRefs(gitCtxOrError, args.name);

		return { stdout: "", stderr: "", exitCode: 0 };
	};

	const removeArgs = [a.string().name("name").describe("Remote name")] as const;

	remote.command("remove", {
		description: "Remove the remote named <name>",

		args: removeArgs,
		handler: removeHandler,
	});

	remote.command("rm", {
		description: "Remove the remote named <name>",

		args: removeArgs,
		handler: removeHandler,
	});

	remote.command("rename", {
		description: "Rename the remote named <old> to <new>",

		args: [
			a.string().name("old").describe("Current remote name"),
			a.string().name("new").describe("New remote name"),
		],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;

			const config = await readConfig(gitCtxOrError);
			return handleRename(gitCtxOrError, config, args.old, args.new);
		},
	});

	remote.command("set-url", {
		description: "Change the URL for an existing remote",

		args: [
			a.string().name("name").describe("Remote name"),
			a.string().name("url").describe("New remote URL"),
		],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;

			const config = await readConfig(gitCtxOrError);
			const sectionKey = `remote "${args.name}"`;
			if (!(sectionKey in config)) {
				return err(`error: No such remote '${args.name}'\n`, 2);
			}

			const section = config[sectionKey];
			if (section) section.url = args.url;
			await writeConfig(gitCtxOrError, config);
			return { stdout: "", stderr: "", exitCode: 0 };
		},
	});

	remote.command("get-url", {
		description: "Retrieve the URL for an existing remote",

		args: [a.string().name("name").describe("Remote name")],
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;

			const config = await readConfig(gitCtxOrError);
			const sectionKey = `remote "${args.name}"`;
			if (!(sectionKey in config)) {
				return err(`error: No such remote '${args.name}'\n`, 2);
			}

			const url = config[sectionKey]?.url ?? "";
			return { stdout: `${url}\n`, stderr: "", exitCode: 0 };
		},
	});
}

// ── Rename handler ──────────────────────────────────────────────────

async function handleRename(
	gitCtx: GitContext,
	config: GitConfig,
	oldName: string,
	newName: string,
): Promise<CommandResult> {
	if (!checkRefFormat(`refs/remotes/${newName}`, RefFormatFlag.NONE)) {
		return fatal(`'${newName}' is not a valid remote name`);
	}

	const oldSection = `remote "${oldName}"`;
	if (!(oldSection in config)) {
		return err(`error: No such remote: '${oldName}'\n`, 2);
	}

	const newSection = `remote "${newName}"`;
	if (newSection in config) {
		return fatal(`remote ${newName} already exists.`);
	}

	const oldConfig = { ...config[oldSection] };
	if (oldConfig.fetch) {
		oldConfig.fetch = oldConfig.fetch.replace(
			`refs/remotes/${oldName}/`,
			`refs/remotes/${newName}/`,
		);
	}
	config[newSection] = oldConfig;
	delete config[oldSection];

	for (const section of Object.keys(config)) {
		const match = section.match(/^branch "(.+)"$/);
		if (match && config[section]?.remote === oldName) {
			config[section].remote = newName;
		}
	}

	await writeConfig(gitCtx, config);

	const oldPrefix = `refs/remotes/${oldName}`;
	const refs = await listRefs(gitCtx, oldPrefix);
	for (const ref of refs) {
		const newRefName = ref.name.replace(oldPrefix, `refs/remotes/${newName}`);
		const oldEntries = await readReflog(gitCtx, ref.name);
		await updateRef(gitCtx, newRefName, ref.hash);
		await deleteRef(gitCtx, ref.name);
		if (oldEntries.length > 0) {
			await writeReflog(gitCtx, newRefName, oldEntries);
		}
	}

	return { stdout: "", stderr: "", exitCode: 0 };
}

// ── Cleanup helpers ─────────────────────────────────────────────────

function cleanupBranchTrackingConfig(config: GitConfig, remoteName: string): void {
	for (const section of Object.keys(config)) {
		const match = section.match(/^branch "(.+)"$/);
		if (match && config[section]?.remote === remoteName) {
			delete config[section].remote;
			delete config[section].merge;
			if (Object.keys(config[section]).length === 0) {
				delete config[section];
			}
		}
	}
}

async function cleanupTrackingRefs(gitCtx: GitContext, remoteName: string): Promise<void> {
	const prefix = `refs/remotes/${remoteName}`;
	const refs = await listRefs(gitCtx, prefix);
	for (const ref of refs) {
		await deleteRef(gitCtx, ref.name);
	}
}
