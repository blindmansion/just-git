import type { ArgBuilder } from "./builders/arg.ts";
import type { FlagBuilder } from "./builders/flag.ts";
import type { OptionBuilder } from "./builders/option.ts";
import { findSuggestions, formatErrors } from "./errors.ts";
import { generateHelp } from "./help.ts";
import { camelToKebab, parseArgs } from "./parser.ts";
import type { ArgsSchema, CommandContext, ExecResult, Handler, OptionsSchema } from "./types.ts";

// ============================================================================
// Type utilities
// ============================================================================

/** Flatten intersections for clean hover display */
type Prettify<T> = {
	[K in keyof T as string extends K ? never : K]: T[K];
} & {};

/** Builder input types — what the user passes in config */
type OptionInput = OptionBuilder<any, any> | FlagBuilder<any>;
type OptionsInput = Record<string, OptionInput>;
type ArgsInput = readonly ArgBuilder<any, any, any>[];

/** Infer the value types from option builder instances (handler signature) */
type InferOptionsFromInput<T extends OptionsInput> = {
	[K in keyof T]: T[K] extends OptionBuilder<infer V, any>
		? V
		: T[K] extends FlagBuilder<true>
			? number
			: T[K] extends FlagBuilder
				? boolean
				: never;
};

/** Infer positional arg types from arg builder instances (handler signature) */
type InferArgsFromInput<T extends ArgsInput> = {
	[I in keyof T & `${number}` as T[I] extends ArgBuilder<any, infer N extends string, any>
		? N
		: never]: T[I] extends ArgBuilder<infer V, any, any> ? V : never;
};

/** Infer invoke() options: required options mandatory, defaulted/optional/flags optional */
type InferInvokeOptions<T extends OptionsInput> = {
	[K in keyof T as T[K] extends FlagBuilder<any>
		? never
		: T[K] extends OptionBuilder<infer V, infer D>
			? [D] extends [true]
				? never
				: undefined extends V
					? never
					: K
			: never]: T[K] extends OptionBuilder<infer V, any> ? V : never;
} & {
	[K in keyof T as T[K] extends FlagBuilder<any>
		? K
		: T[K] extends OptionBuilder<infer V, infer D>
			? [D] extends [true]
				? K
				: undefined extends V
					? K
					: never
			: never]?: T[K] extends OptionBuilder<infer V, any>
		? V
		: T[K] extends FlagBuilder<true>
			? number
			: T[K] extends FlagBuilder
				? boolean
				: never;
};

/** Infer invoke() args: required args mandatory, defaulted/optional args optional */
type InferInvokeArgs<T extends ArgsInput> = {
	[I in keyof T & `${number}` as T[I] extends ArgBuilder<infer _V, infer N extends string, infer D>
		? [D] extends [true]
			? never
			: T[I] extends ArgBuilder<infer V, any, any>
				? undefined extends V
					? never
					: N
				: never
		: never]: T[I] extends ArgBuilder<infer V, any, any> ? V : never;
} & {
	[I in keyof T & `${number}` as T[I] extends ArgBuilder<infer _V, infer N extends string, infer D>
		? [D] extends [true]
			? N
			: T[I] extends ArgBuilder<infer V, any, any>
				? undefined extends V
					? N
					: never
				: never
		: never]?: T[I] extends ArgBuilder<infer V, any, any> ? V : never;
};

// ============================================================================
// Runtime helpers — extract defs from builder instances
// ============================================================================

function resolveOptionsInput(input: OptionsInput | undefined): OptionsSchema {
	if (!input) return {};
	const result: Record<string, any> = {};
	for (const [key, builder] of Object.entries(input)) {
		result[key] = builder._def;
	}
	return result;
}

function resolveArgsInput(input: ArgsInput | undefined): ArgsSchema {
	if (!input) return [];
	return input.map((builder) => builder._def);
}

// ============================================================================
// Command class
// ============================================================================

export class Command<THandlerArgs extends object = {}, TInvokeArgs extends object = {}> {
	readonly name: string;
	readonly description: string;
	readonly options: OptionsSchema;
	readonly args: ArgsSchema;
	readonly examples: readonly string[];
	readonly handler?: Handler<any>;
	readonly transformArgs?: (tokens: string[]) => string[];
	readonly children = new Map<string, Command<any, any>>();
	parent?: Command<any, any>;

	/** @internal — phantom type carrying the resolved handler args */
	declare readonly _handlerArgs: THandlerArgs;
	/** @internal — phantom type carrying the resolved invoke args */
	declare readonly _invokeArgs: TInvokeArgs;

	/** @internal */
	constructor(
		name: string,
		description: string,
		options: OptionsSchema,
		args: ArgsSchema,
		examples: readonly string[],
		handler: Handler<any> | undefined,
		transformArgs?: (tokens: string[]) => string[],
	) {
		this.name = name;
		this.description = description;
		this.options = options;
		this.args = args;
		this.examples = examples;
		this.handler = handler;
		this.transformArgs = transformArgs;
	}

	// --------------------------------------------------------------------------
	// Tree building
	// --------------------------------------------------------------------------

	/** Add a subcommand. Returns the child command for further nesting. */
	command<TOpts extends OptionsInput = {}, const TArgs extends ArgsInput = []>(
		name: string,
		config: {
			readonly description: string;
			readonly options?: TOpts;
			readonly args?: TArgs;
			readonly examples?: readonly string[];
			readonly transformArgs?: (tokens: string[]) => string[];
			readonly handler?: Handler<
				Prettify<InferOptionsFromInput<TOpts> & InferArgsFromInput<TArgs>>
			>;
		},
	): Command<
		Prettify<InferOptionsFromInput<TOpts> & InferArgsFromInput<TArgs>>,
		Prettify<InferInvokeOptions<TOpts> & InferInvokeArgs<TArgs>>
	> {
		const child = new Command(
			name,
			config.description,
			resolveOptionsInput(config.options),
			resolveArgsInput(config.args),
			config.examples ?? [],
			config.handler as Handler<any> | undefined,
			config.transformArgs,
		);
		child.parent = this;
		this.children.set(name, child);
		return child as any;
	}

	// --------------------------------------------------------------------------
	// Computed properties
	// --------------------------------------------------------------------------

	/** Full path from root (e.g. "mycli db migrate") */
	get fullPath(): string {
		const segments: string[] = [];
		let current: Command<any, any> | undefined = this;
		while (current) {
			segments.unshift(current.name);
			current = current.parent;
		}
		return segments.join(" ");
	}

	/**
	 * Return a plain `{ name, execute }` object compatible with just-bash's
	 * `CustomCommand` interface, with `execute` pre-bound to this command tree.
	 *
	 * @example
	 * ```ts
	 * const bash = new Bash({ customCommands: [mycli.toCommand()] });
	 * ```
	 */
	toCommand(): {
		name: string;
		execute: (args: string[], ctx: CommandContext) => Promise<ExecResult>;
	} {
		return { name: this.name, execute: this.execute.bind(this) };
	}

	/** All options available to this command */
	get allOptions(): OptionsSchema {
		return this.options;
	}

	// --------------------------------------------------------------------------
	// Programmatic invocation
	// --------------------------------------------------------------------------

	/**
	 * Serialize a typed args object into CLI tokens.
	 *
	 * Produces tokens that, when parsed, reproduce the given args.
	 * Useful for building commands to pass to `execute()` or composing
	 * with `fullPath` for string-based execution.
	 *
	 * Only explicitly-provided values are serialized — omit a key to let
	 * the parser apply its default or env fallback as usual.
	 *
	 * @example
	 * ```ts
	 * const tokens = serve.toTokens({ port: 8080, entry: "app.ts" });
	 * await cli.execute(["serve", ...tokens], ctx);
	 * ```
	 */
	toTokens(args: Partial<THandlerArgs>): string[] {
		const tokens: string[] = [];
		const allOpts = this.allOptions;
		const input = args as Record<string, unknown>;

		// Options and flags
		for (const [key, def] of Object.entries(allOpts)) {
			const value = input[key];
			const kebab = camelToKebab(key);

			if (def._kind === "flag") {
				if (def.counted && typeof value === "number" && value > 0) {
					for (let n = 0; n < value; n++) tokens.push(`--${kebab}`);
				} else if (value === true) {
					tokens.push(`--${kebab}`);
				} else if (value === false && def.default === true) {
					tokens.push(`--no-${kebab}`);
				}
			} else if (def._kind === "option") {
				if (value !== undefined) {
					tokens.push(`--${kebab}`, String(value));
				}
			}
		}

		// Positional args (in schema order)
		for (const argDef of this.args) {
			const argName = argDef.name ?? "arg";
			const value = input[argName];
			if (value === undefined) continue;

			if (argDef.variadic && Array.isArray(value)) {
				for (const v of value) {
					tokens.push(String(v));
				}
			} else {
				tokens.push(String(value));
			}
		}

		return tokens;
	}

	/**
	 * Call this command's handler directly with typed args.
	 *
	 * Required options (no default) and required positional args must be
	 * provided. Options with defaults, flags, and optional args can be
	 * omitted — invoke applies their defaults automatically.
	 *
	 * @example
	 * ```ts
	 * const result = await serve.invoke({ port: 8080, entry: "app.ts" }, ctx);
	 * ```
	 */
	async invoke(args: TInvokeArgs, ctx: CommandContext): Promise<ExecResult> {
		if (!this.handler) {
			return {
				stdout: "",
				stderr: `Command "${this.fullPath}" has no handler`,
				exitCode: 1,
			};
		}

		const resolved: Record<string, unknown> = {
			...(args as Record<string, unknown>),
		};
		const allOpts = this.allOptions;

		// Apply defaults for missing options/flags
		for (const [key, def] of Object.entries(allOpts)) {
			if (resolved[key] === undefined) {
				if (def._kind === "flag") {
					resolved[key] = def.default ?? (def.counted ? 0 : false);
				} else if (def._kind === "option") {
					if (def.default !== undefined) {
						resolved[key] = def.default;
					} else if (def.required) {
						return {
							stdout: "",
							stderr: `Missing required option "${key}"`,
							exitCode: 1,
						};
					}
				}
			}
		}

		// Apply defaults for missing positional args
		for (const argDef of this.args) {
			const argName = argDef.name ?? "arg";
			if (resolved[argName] === undefined) {
				if (argDef.default !== undefined) {
					resolved[argName] = argDef.default;
				} else if (argDef.required) {
					return {
						stdout: "",
						stderr: `Missing required arg "${argName}"`,
						exitCode: 1,
					};
				}
			}
		}

		try {
			return await this.handler(resolved, ctx, { passthrough: [] });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { stdout: "", stderr: message, exitCode: 1 };
		}
	}

	// --------------------------------------------------------------------------
	// Execution
	// --------------------------------------------------------------------------

	/**
	 * Execute this command tree with the given tokens.
	 *
	 * Tokens flow through the tree: each level consumes the subcommand name
	 * and passes the rest deeper. When no subcommand matches, the current
	 * node either parses and runs its handler, or returns help/error.
	 */
	async execute(tokens: readonly string[], ctx: CommandContext): Promise<ExecResult> {
		const env = ctx?.env ? Object.fromEntries(ctx.env) : {};
		const firstToken = tokens[0];

		// Try to match a subcommand (must come before flags)
		if (firstToken && !firstToken.startsWith("-")) {
			const child = this.children.get(firstToken);
			if (child) {
				return child.execute(tokens.slice(1), ctx);
			}
		}

		// No subcommand matched — check for --help
		if (hasHelpFlag(tokens)) {
			return { stdout: generateHelp(this), stderr: "", exitCode: 0 };
		}

		// Has a handler — parse remaining tokens and run it
		if (this.handler) {
			const effective = this.transformArgs ? this.transformArgs([...tokens]) : [...tokens];
			const parsed = parseArgs(this.allOptions, this.args, effective, env);
			if (!parsed.ok) {
				return { stdout: "", stderr: formatErrors(parsed.errors), exitCode: 1 };
			}
			try {
				return await this.handler(parsed.args, ctx, {
					passthrough: parsed.passthrough,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { stdout: "", stderr: message, exitCode: 1 };
			}
		}

		// No handler — check for unknown subcommand
		if (firstToken && !firstToken.startsWith("-")) {
			const suggestions = findSuggestions(firstToken, [...this.children.keys()]);
			return {
				stdout: "",
				stderr: formatErrors([
					{
						type: "unknown_command",
						path: `${this.fullPath} ${firstToken}`,
						suggestions,
					},
				]),
				exitCode: 1,
			};
		}

		// Bare invocation, no handler — show help
		return { stdout: generateHelp(this), stderr: "", exitCode: 0 };
	}
}

// ============================================================================
// Factory function
// ============================================================================

/** Create a command (typically the root of your CLI) */
export function command<TOpts extends OptionsInput = {}, const TArgs extends ArgsInput = []>(
	name: string,
	config: {
		readonly description: string;
		readonly options?: TOpts;
		readonly args?: TArgs;
		readonly examples?: readonly string[];
		readonly transformArgs?: (tokens: string[]) => string[];
		readonly handler?: Handler<Prettify<InferOptionsFromInput<TOpts> & InferArgsFromInput<TArgs>>>;
	},
): Command<
	Prettify<InferOptionsFromInput<TOpts> & InferArgsFromInput<TArgs>>,
	Prettify<InferInvokeOptions<TOpts> & InferInvokeArgs<TArgs>>
> {
	return new Command(
		name,
		config.description,
		resolveOptionsInput(config.options),
		resolveArgsInput(config.args),
		config.examples ?? [],
		config.handler as Handler<any> | undefined,
		config.transformArgs,
	) as any;
}

// ============================================================================
// Helpers
// ============================================================================

function hasHelpFlag(tokens: readonly string[]): boolean {
	return tokens.some((t) => t === "--help" || t === "-h");
}
