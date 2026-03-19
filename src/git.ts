import { createGitCommand } from "./commands/git.ts";
import type { FileSystem } from "./fs.ts";
import {
	type CredentialProvider,
	type ExecResult,
	type FetchFunction,
	type GitHooks,
	type IdentityOverride,
	type NetworkPolicy,
	isRejection,
} from "./hooks.ts";
import type { ObjectStore, RefStore, RemoteResolver } from "./lib/types.ts";

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
	| "bisect";

export interface GitOptions {
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
	 * Override the object store discovered by `findRepo`.
	 * When set, all object reads/writes bypass the VFS `.git/objects/`
	 * and go through this store instead (e.g. SQLite-backed).
	 */
	objectStore?: ObjectStore;
	/**
	 * Override the ref store discovered by `findRepo`.
	 * When set, all ref reads/writes bypass the VFS `.git/refs/`
	 * and go through this store instead (e.g. SQLite-backed).
	 */
	refStore?: RefStore;
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
}

/** Simplified context for {@link Git.exec}. */
export interface ExecContext {
	fs: FileSystem;
	cwd: string;
	env?: Record<string, string>;
	stdin?: string;
}

export class Git {
	readonly name = "git";
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
		this.hooks = options?.hooks;
		this.blocked = options?.disabled?.length ? new Set<string>(options.disabled) : null;
		const network = options?.network;
		const extensions: GitExtensions = {
			hooks: options?.hooks,
			credentialProvider: options?.credentials,
			identityOverride: options?.identity,
			fetchFn: typeof network === "object" ? network.fetch : undefined,
			networkPolicy: network,
			resolveRemote: options?.resolveRemote,
			...(options?.objectStore ? { objectStore: options.objectStore } : {}),
			...(options?.refStore ? { refStore: options.refStore } : {}),
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
	 * await git.exec('commit -m "initial commit"', { fs, cwd: "/repo" });
	 * ```
	 */
	exec = async (command: string, ctx: ExecContext): Promise<ExecResult> => {
		const args = tokenizeCommand(command);
		const env = new Map<string, string>();
		if (ctx.env) {
			for (const [k, v] of Object.entries(ctx.env)) {
				env.set(k, v);
			}
		}
		return this.execute(args, { fs: ctx.fs, cwd: ctx.cwd, env, stdin: ctx.stdin ?? "" });
	};

	execute = (args: string[], ctx: CommandContext): Promise<ExecResult> => {
		return this.withLock(ctx.fs, async () => {
			const command = args[0] ?? "";

			if (this.blocked?.has(command)) {
				return {
					stdout: "",
					stderr: `git: '${command}' is not available in this environment\n`,
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

export function createGit(options?: GitOptions): Git {
	return new Git(options);
}
