import { KNOWN_UNIMPLEMENTED_COMMANDS, createGitCommand } from "./commands/git.ts";
import type { FileSystem } from "./fs.ts";
import {
	type ConfigOverrides,
	type CredentialProvider,
	type ExecResult,
	type FetchFunction,
	type GitHooks,
	type IdentityOverride,
	type NetworkPolicy,
	isRejection,
} from "./hooks.ts";
import type { ObjectStore, RefStore, RemoteResolver } from "./lib/types.ts";

export const VERSION = "1.3.9";

/** Options for subcommand execution (mirrors just-bash's CommandExecOptions). */
export interface CommandExecOptions {
	env?: Record<string, string>;
	replaceEnv?: boolean;
	cwd: string;
	stdin?: string;
	signal?: AbortSignal;
}

/**
 * Context provided to commands during execution.
 * Shadows just-bash's CommandContext — structurally compatible
 * so this library can run with or without just-bash.
 */
export interface CommandContext {
	fs: FileSystem;
	cwd: string;
	env: Map<string, string>;
	stdin: string;
	exec?: (command: string, options: CommandExecOptions) => Promise<ExecResult>;
	signal?: AbortSignal;
}

/** Git subcommand name. Used with {@link GitOptions.disabled} to block specific commands. */
export type GitCommandName =
	| "init"
	| "clone"
	| "fetch"
	| "pull"
	| "push"
	| "add"
	| "blame"
	| "commit"
	| "status"
	| "log"
	| "branch"
	| "tag"
	| "checkout"
	| "describe"
	| "diff"
	| "reset"
	| "merge"
	| "cherry-pick"
	| "revert"
	| "rebase"
	| "mv"
	| "rm"
	| "remote"
	| "config"
	| "show"
	| "stash"
	| "rev-parse"
	| "ls-files"
	| "clean"
	| "switch"
	| "restore"
	| "reflog"
	| "repack"
	| "gc"
	| "bisect"
	| "grep";

/**
 * Configuration for a {@link Git} instance.
 *
 * Controls hooks, identity, credentials, network access, command
 * restrictions, and config overrides for all commands run through
 * this instance.
 */
export interface GitOptions {
	/**
	 * Default filesystem for {@link Git.exec}. When set, `exec` calls
	 * don't need to pass `fs` in the context. Ignored by `execute`
	 * (just-bash always provides its own filesystem).
	 */
	fs?: FileSystem;
	/**
	 * Default working directory for {@link Git.exec}. Defaults to `"/"`.
	 * Per-call `cwd` in {@link ExecContext} overrides this.
	 * Ignored by `execute` (just-bash provides its own cwd).
	 */
	cwd?: string;
	hooks?: GitHooks;
	credentials?: CredentialProvider;
	identity?: IdentityOverride;
	disabled?: GitCommandName[];
	/** Network policy. Set to `false` to block all HTTP access. */
	network?: NetworkPolicy | false;
	/**
	 * Resolve a remote URL to a GitContext on a potentially different VFS.
	 * Called before local filesystem lookup for non-HTTP remote URLs.
	 * Return null to fall back to local filesystem resolution.
	 */
	resolveRemote?: RemoteResolver;
	/**
	 * Object store to use instead of filesystem-backed `.git/objects/`.
	 * When both `objectStore` and `refStore` are set, `findRepo` is
	 * skipped entirely — no `.git` directory needs to exist on the VFS.
	 */
	objectStore?: ObjectStore;
	/**
	 * Ref store to use instead of filesystem-backed `.git/refs/`.
	 * When both `objectStore` and `refStore` are set, `findRepo` is
	 * skipped entirely — no `.git` directory needs to exist on the VFS.
	 */
	refStore?: RefStore;
	/**
	 * Explicit `.git` directory path. When set together with
	 * `objectStore` and `refStore`, `findRepo` is skipped entirely —
	 * no `.git` directory needs to exist on the VFS. Index, config,
	 * reflog, and operation state files are stored under this path.
	 */
	gitDir?: string;
	/**
	 * Config overrides. `locked` values always win over `.git/config`;
	 * `defaults` supply fallbacks when a key is absent from config.
	 */
	config?: ConfigOverrides;
}

/**
 * Bundle of operator-level extensions threaded into command handlers
 * via closures and merged onto GitContext after discovery.
 */
export interface GitExtensions {
	hooks?: GitHooks;
	credentialProvider?: CredentialProvider;
	identityOverride?: IdentityOverride;
	fetchFn?: FetchFunction;
	networkPolicy?: NetworkPolicy | false;
	resolveRemote?: RemoteResolver;
	objectStore?: ObjectStore;
	refStore?: RefStore;
	configOverrides?: ConfigOverrides;
	/**
	 * Pre-resolved .git directory path. When set together with
	 * `objectStore` and `refStore`, `requireGitContext` skips
	 * filesystem discovery (`findRepo`) entirely.
	 */
	gitDir?: string;
	/** Pre-resolved worktree root. Used with `gitDir` to skip discovery. */
	workTree?: string;
}

/** Simplified context for {@link Git.exec}. */
export interface ExecContext {
	/** Filesystem to operate on. Falls back to the `fs` set in {@link GitOptions}. */
	fs?: FileSystem;
	/** Working directory. Falls back to the `cwd` set in {@link GitOptions}, then `"/"`. */
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
}

/**
 * Merge identity override into config overrides so that `git config user.name`
 * and `git config user.email` reflect the operator-supplied identity.
 *
 * Locked identities become locked config values (cannot be overridden by
 * `git config set`). Unlocked identities become default config values
 * (agent can override with `git config set`).
 */
function mergeIdentityIntoConfig(
	identity: IdentityOverride | undefined,
	config: ConfigOverrides | undefined,
): ConfigOverrides | undefined {
	if (!identity) return config;

	const tier = identity.locked ? "locked" : "defaults";
	const entries: Record<string, string> = {
		"user.name": identity.name,
		"user.email": identity.email,
	};

	if (!config) return { [tier]: entries };

	return {
		...config,
		[tier]: { ...entries, ...config[tier] },
	};
}

/**
 * Git command handler. Runs git subcommands against a virtual filesystem.
 *
 * Create via {@link createGit}. Use as a standalone executor with
 * {@link Git.exec}, or pass directly into just-bash's `customCommands`
 * to make `git` available inside a virtual shell.
 *
 * ```ts
 * const git = createGit({ fs: new MemoryFileSystem() });
 * await git.exec("init");
 * ```
 */
export class Git {
	readonly name = "git";
	private defaultFs: FileSystem | undefined;
	private defaultCwd: string;
	private blocked: Set<string> | null;
	private hooks: GitHooks | undefined;
	private inner: { execute: (args: string[], ctx: CommandContext) => Promise<ExecResult> };
	private locks = new WeakMap<object, Promise<unknown>>();

	private async withLock<T>(key: object, fn: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		this.locks.set(key, gate);
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	constructor(options?: GitOptions) {
		this.defaultFs = options?.fs;
		this.defaultCwd = options?.cwd ?? "/";
		this.hooks = options?.hooks;
		this.blocked = options?.disabled?.length ? new Set<string>(options.disabled) : null;
		const network = options?.network;

		const configOverrides = mergeIdentityIntoConfig(options?.identity, options?.config);

		const extensions: GitExtensions = {
			hooks: options?.hooks,
			credentialProvider: options?.credentials,
			identityOverride: options?.identity,
			fetchFn: typeof network === "object" ? network.fetch : undefined,
			networkPolicy: network,
			resolveRemote: options?.resolveRemote,
			...(options?.objectStore ? { objectStore: options.objectStore } : {}),
			...(options?.refStore ? { refStore: options.refStore } : {}),
			...(options?.gitDir
				? {
						gitDir: options.gitDir,
						workTree: this.defaultCwd,
					}
				: {}),
			...(configOverrides ? { configOverrides } : {}),
		};
		this.inner = createGitCommand(extensions).toCommand();
	}

	/**
	 * Run a git command from a string.
	 *
	 * Tokenizes the input with basic shell quoting (single/double quotes).
	 * Strips a leading `git ` prefix if present. Does not support shell
	 * features like pipes, redirections, variable expansion, or `&&`.
	 *
	 * ```ts
	 * await git.exec('commit -m "initial commit"');
	 * ```
	 */
	exec = async (command: string, ctx?: ExecContext): Promise<ExecResult> => {
		const fs = ctx?.fs ?? this.defaultFs;
		if (!fs) {
			throw new Error("No filesystem: pass `fs` in exec() options or in createGit()");
		}
		const cwd = ctx?.cwd ?? this.defaultCwd;
		const args = tokenizeCommand(command);
		const env = new Map<string, string>();
		if (ctx?.env) {
			for (const [k, v] of Object.entries(ctx.env)) {
				env.set(k, v);
			}
		}
		return this.execute(args, { fs, cwd, env, stdin: ctx?.stdin ?? "" });
	};

	execute = (args: string[], ctx: CommandContext): Promise<ExecResult> => {
		return this.withLock(ctx.fs, async () => {
			const command = args[0] ?? "";

			if (command === "--version" || command === "version") {
				return {
					stdout: `just-git version ${VERSION} (virtual git implementation)\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			if (this.blocked?.has(command)) {
				return {
					stdout: "",
					stderr: `git: '${command}' is not available in this environment\n`,
					exitCode: 1,
				};
			}

			if (command && KNOWN_UNIMPLEMENTED_COMMANDS.has(command)) {
				return {
					stdout: "",
					stderr: `git: '${command}' is not implemented. Run 'git help' for available commands.\n`,
					exitCode: 1,
				};
			}

			if (this.hooks?.beforeCommand) {
				const rej = await this.hooks.beforeCommand({
					command,
					args: args.slice(1),
					fs: ctx.fs,
					cwd: ctx.cwd,
					env: ctx.env,
				});
				if (isRejection(rej)) {
					return {
						stdout: "",
						stderr: rej.message ?? "",
						exitCode: 1,
					};
				}
			}

			const result = await this.inner.execute(args, ctx);

			if (this.hooks?.afterCommand) {
				await this.hooks.afterCommand({
					command,
					args: args.slice(1),
					result,
				});
			}

			return result;
		});
	};
}

/**
 * Tokenize a command string with basic shell quoting.
 * Supports single quotes, double quotes (with backslash escapes),
 * and whitespace splitting. Strips a leading "git" token if present.
 */
export function tokenizeCommand(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let i = 0;

	while (i < input.length) {
		const ch = input[i]!;

		if (ch === '"') {
			i++;
			while (i < input.length && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < input.length) {
					const next = input[i + 1]!;
					if (next === '"' || next === "\\") {
						current += next;
						i += 2;
						continue;
					}
				}
				current += input[i];
				i++;
			}
			i++; // closing quote
		} else if (ch === "'") {
			i++;
			while (i < input.length && input[i] !== "'") {
				current += input[i];
				i++;
			}
			i++; // closing quote
		} else if (ch === " " || ch === "\t") {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			i++;
		} else {
			current += ch;
			i++;
		}
	}

	if (current.length > 0) {
		tokens.push(current);
	}

	if (tokens.length > 0 && tokens[0] === "git") {
		tokens.shift();
	}

	return tokens;
}

/** Create a new {@link Git} command handler with the given options. */
export function createGit(options?: GitOptions): Git {
	return new Git(options);
}
