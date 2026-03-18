import { createGitCommand } from "./commands/git.ts";
import type { FileSystem } from "./fs.ts";
import {
	type CommandEvent,
	type CredentialProvider,
	type ExecResult,
	type FetchFunction,
	HookEmitter,
	type HookEventMap,
	type HookHandler,
	type IdentityOverride,
	type Middleware,
	type NetworkPolicy,
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
	 * Override the object store discovered by `findGitDir`.
	 * When set, all object reads/writes bypass the VFS `.git/objects/`
	 * and go through this store instead (e.g. SQLite-backed).
	 */
	objectStore?: ObjectStore;
	/**
	 * Override the ref store discovered by `findGitDir`.
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
	hooks?: HookEmitter;
	credentialProvider?: CredentialProvider;
	identityOverride?: IdentityOverride;
	fetchFn?: FetchFunction;
	networkPolicy?: NetworkPolicy | false;
	resolveRemote?: RemoteResolver;
	objectStore?: ObjectStore;
	refStore?: RefStore;
}

export class Git {
	readonly name = "git";
	readonly hooks: HookEmitter;
	private middlewares: Middleware[] = [];
	private extensions: GitExtensions;
	private inner: { execute: (args: string[], ctx: CommandContext) => Promise<ExecResult> };

	constructor(options?: GitOptions) {
		this.hooks = new HookEmitter();
		const network = options?.network;
		this.extensions = {
			hooks: this.hooks,
			credentialProvider: options?.credentials,
			identityOverride: options?.identity,
			fetchFn: typeof network === "object" ? network.fetch : undefined,
			networkPolicy: network,
			resolveRemote: options?.resolveRemote,
			...(options?.objectStore ? { objectStore: options.objectStore } : {}),
			...(options?.refStore ? { refStore: options.refStore } : {}),
		};
		if (options?.disabled?.length) {
			const blocked = new Set<string>(options.disabled);
			this.use(async (event, next) => {
				if (event.command && blocked.has(event.command)) {
					return {
						stdout: "",
						stderr: `git: '${event.command}' is not available in this environment\n`,
						exitCode: 1,
					};
				}
				return next();
			});
		}
		this.inner = createGitCommand(this.extensions).toCommand();
	}

	on<E extends keyof HookEventMap>(event: E, handler: HookHandler<E>): () => void {
		return this.hooks.on(event, handler);
	}

	use(middleware: Middleware): () => void {
		this.middlewares.push(middleware);
		return () => {
			const idx = this.middlewares.indexOf(middleware);
			if (idx !== -1) this.middlewares.splice(idx, 1);
		};
	}

	execute = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
		const event: CommandEvent = {
			command: args[0],
			rawArgs: args.slice(1),
			fs: ctx.fs,
			cwd: ctx.cwd,
			env: ctx.env,
			stdin: ctx.stdin,
			exec: ctx.exec,
			signal: ctx.signal,
		};
		return this.runMiddleware(event, () => this.inner.execute(args, ctx));
	};

	private async runMiddleware(
		event: CommandEvent,
		innerFn: () => Promise<ExecResult>,
	): Promise<ExecResult> {
		if (this.middlewares.length === 0) return innerFn();

		let index = 0;
		const chain = async (): Promise<ExecResult> => {
			if (index >= this.middlewares.length) return innerFn();
			const mw = this.middlewares[index++] as Middleware;
			return mw(event, chain);
		};
		return chain();
	}
}

export function createGit(options?: GitOptions): Git {
	return new Git(options);
}
