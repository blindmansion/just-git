import { KNOWN_UNIMPLEMENTED_COMMANDS, createGitCommand } from "./commands/git.ts";
import type { FileSystem } from "./fs.ts";
import {
	type ConfigOverrides,
	type CredentialProvider,
	type CredentialStore,
	createMemoryCredentialStore,
	type ExecResult,
	type GitHooks,
	type IdentityOverride,
	type NetworkPolicy,
	type ProgressCallback,
	isRejection,
} from "./hooks.ts";
import type { AttributeResolver } from "./lib/attribute-resolver.ts";
import { withCapabilities } from "./lib/capabilities.ts";
import { findRepo as findRepoOnFs } from "./lib/repo.ts";
import type { SigningCapability } from "./lib/signing.ts";
import { makeDefaultTransport } from "./lib/transport/resolver.ts";
import type {
	GitContext,
	ObjectStore,
	RefStore,
	RemoteResolver,
	RepoCapabilities,
} from "./lib/types.ts";

export const VERSION = "1.7.1";

/** Options for subcommand execution (mirrors just-bash's CommandExecOptions). */
export interface CommandExecOptions {
	env?: Record<string, string>;
	replaceEnv?: boolean;
	cwd: string;
	stdin?: string;
	stdinKind?: "text" | "bytes";
	signal?: AbortSignal;
}

/**
 * Standard input passed to commands.
 *
 * Standalone `Git.exec()` calls use plain text strings. Shell integrations such as
 * just-bash v3 pass an opaque byte string instead, so command handlers must decode
 * stdin at text-reading boundaries.
 */
export type CommandStdin = string | object;

/**
 * Context provided to commands during execution.
 * Shadows just-bash's CommandContext — structurally compatible
 * so this library can run with or without just-bash.
 */
export interface CommandContext {
	fs: FileSystem;
	cwd: string;
	env: Map<string, string>;
	stdin: CommandStdin;
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
	| "check-attr"
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
	| "grep"
	| "shortlog";

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
	/**
	 * Called with server progress messages during network operations
	 * (fetch, clone, push). Messages are raw sideband text from the
	 * remote — format varies by server.
	 */
	onProgress?: ProgressCallback;
	/**
	 * The single `.gitattributes`-driven seam, resolving which behaviors apply
	 * to a path: content filters (`filter=`), merge drivers (`merge=`), and more.
	 * Build one with `gitAttributes({ filters, mergeDrivers, locked, defaults })`
	 * (in-tree `.gitattributes` selection + `name → impl` registries) or
	 * `everyPath({ merge })` / `everyPath({ filter })` to apply one behavior to
	 * every path (the legacy global merge-driver / filters ergonomic). Drivers
	 * fire on `merge` / `cherry-pick` / `revert` / `rebase` / `pull`; filters on
	 * check-in (`add`, `commit -a`, `status`) and check-out (`checkout`, merge).
	 */
	attributes?: AttributeResolver;
	/**
	 * Pluggable commit/tag signing and verification. Both halves are
	 * independent and optional:
	 *
	 * - `signer` (write side) turns a canonical payload into an armored
	 *   signature block. Often needs subprocess/agent authority.
	 * - `verifier` (read side) turns a payload + signature into a trust
	 *   verdict. Frequently pure-TS and sandbox-safe, so it can be supplied
	 *   even when signing is not.
	 *
	 * Whether signing/verification actually happens is gated by git config
	 * (`commit.gpgsign`, `tag.gpgsign`, `merge.verifysignatures`, ...) and
	 * per-command flags — the same policy/mechanism split git uses.
	 *
	 * Note the deliberate asymmetry between layers: an ambient `signer` set
	 * here does NOT make the bare repo SDK writers (`createCommit`,
	 * `buildCommit`, `commit`, `createAnnotatedTag`) sign by default — those
	 * sign only when given an explicit `sign: true` or per-call `signer`. The
	 * config-gated "sign because policy says so" behavior lives at the command
	 * layer (`git commit`, `git merge`, ...), keeping the object-writing SDK
	 * explicit rather than implicitly signing off ambient state.
	 */
	signing?: SigningCapability;
	/**
	 * Injected clock for author/committer/reflog timestamps. When omitted,
	 * the system clock is used. Supplying it makes recorded times
	 * deterministic without setting `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`
	 * on every call — useful for tests and host-controlled clocks.
	 */
	now?: () => Date;
	/**
	 * Store for credentials stripped from a URL by `git remote add` / `git clone`
	 * so a later `fetch` / `push` on the same instance can reuse them. Defaults
	 * to an in-memory, instance-scoped store ({@link createMemoryCredentialStore}).
	 * Supply a custom {@link CredentialStore} to back it with an OS keychain,
	 * encrypted-at-rest storage, etc. For credentials you already hold, prefer
	 * the {@link credentials} provider — it never touches the CLI URL path.
	 */
	credentialStore?: CredentialStore;
}

/**
 * Pre-resolved storage handles + paths that let `requireGitContext` skip
 * filesystem discovery (`findRepo`) entirely. When `objectStore`, `refStore`,
 * and `gitDir` are all present, no `.git` directory needs to exist on the VFS.
 */
export interface RepoLocators {
	objectStore?: ObjectStore;
	refStore?: RefStore;
	/** Pre-resolved .git directory path. */
	gitDir?: string;
	/** Pre-resolved worktree root. */
	workTree?: string;
}

/**
 * Bundle threaded into command handlers via closures. Carries the unified
 * host-behavior bag and the optional pre-resolved storage locators. Built
 * once in {@link createGit}; the `capabilities` are attached to every
 * discovered handle via `withCapabilities`, and carried here (not just on the
 * handle) so the pre-discovery commands (`clone`, `init`) can reach them
 * before a `GitContext` exists.
 */
export interface GitExtensions {
	capabilities?: RepoCapabilities;
	locators?: RepoLocators;
	/**
	 * Instance-scoped credential store (origin → auth) for the CLI front door.
	 * Runtime state, not a host capability: credentials stripped from a URL by
	 * `remote add` / `clone` are stashed here so a later `fetch` / `push` on the
	 * same {@link Git} instance can reuse them. Threaded explicitly into the
	 * transport boundary; never placed on the `GitRepo` / `GitContext` handle.
	 */
	credentialStore?: CredentialStore;
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
	private ext: GitExtensions;
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

		const configOverrides = mergeIdentityIntoConfig(options?.identity, options?.config);

		// Instance-scoped credential store: creds stripped from a URL by
		// `remote add` / `clone` survive to a later `fetch` / `push`. Runtime
		// state, not a capability. Host-overridable via GitOptions.credentialStore.
		const credentialStore = options?.credentialStore ?? createMemoryCredentialStore();

		const capabilities: RepoCapabilities = {
			hooks: options?.hooks,
			signing: options?.signing,
			attributes: options?.attributes,
			identity: options?.identity,
			config: configOverrides,
			// The ergonomic network/credentials/resolveRemote options are sugar:
			// compile them (over the credential store) into the one transport seam.
			transport: makeDefaultTransport(
				{
					network: options?.network,
					credentials: options?.credentials,
					resolveRemote: options?.resolveRemote,
				},
				credentialStore,
			),
			onProgress: options?.onProgress,
			now: options?.now,
		};

		const locators: RepoLocators = {
			...(options?.objectStore ? { objectStore: options.objectStore } : {}),
			...(options?.refStore ? { refStore: options.refStore } : {}),
			...(options?.gitDir ? { gitDir: options.gitDir, workTree: this.defaultCwd } : {}),
		};

		const extensions: GitExtensions = {
			capabilities,
			locators,
			credentialStore,
		};
		this.ext = extensions;
		this.inner = createGitCommand(extensions).toCommand();
	}

	/**
	 * Discover the git repository for the current working directory.
	 *
	 * Uses the instance's default `fs` and `cwd`, with optional per-call
	 * overrides. The returned {@link GitContext} carries all operator-level
	 * extensions (hooks, identity, credentials, config overrides) configured
	 * on this instance, so repo SDK functions receive the full context.
	 *
	 * When the instance was created with explicit `objectStore`, `refStore`,
	 * and `gitDir`, filesystem discovery is skipped entirely.
	 *
	 * ```ts
	 * const repo = await git.findRepo();
	 * if (repo) {
	 *   const history = await walkCommitHistory(repo, headHash);
	 * }
	 * ```
	 */
	async findRepo(ctx?: { fs?: FileSystem; cwd?: string }): Promise<GitContext | null> {
		const fs = ctx?.fs ?? this.defaultFs;
		if (!fs) {
			throw new Error("No filesystem: pass `fs` in findRepo() options or in createGit()");
		}
		const cwd = ctx?.cwd ?? this.defaultCwd;

		const loc = this.ext.locators;
		if (loc?.objectStore && loc?.refStore && loc?.gitDir) {
			return withCapabilities(
				{
					fs,
					gitDir: loc.gitDir,
					workTree: loc.workTree ?? cwd,
					objectStore: loc.objectStore,
					refStore: loc.refStore,
				},
				this.ext.capabilities,
			);
		}

		const found = await findRepoOnFs(fs, cwd);
		if (!found) return null;
		// Hybrid path: locator stores (without a gitDir) override the discovered
		// context's object/ref stores while the filesystem supplies worktree/index.
		return withCapabilities(
			{
				...found,
				...(loc?.objectStore ? { objectStore: loc.objectStore } : {}),
				...(loc?.refStore ? { refStore: loc.refStore } : {}),
			},
			this.ext.capabilities,
		);
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
