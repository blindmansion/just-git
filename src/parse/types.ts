// ============================================================================
// Value type mappings
// ============================================================================

import type { CommandContext } from "../git.ts";
import type { ExecResult } from "../hooks.ts";

export type { CommandContext, ExecResult };

export type TypeMap = {
	string: string;
	number: number;
	boolean: boolean;
};

export type TypeName = keyof TypeMap;

// ============================================================================
// Schema descriptor types
// ============================================================================

export interface OptionDef<TOut = unknown> {
	readonly _kind: "option";
	/** Phantom field — only exists at the type level for inference */
	readonly _type: TOut;
	readonly type: TypeName;
	readonly description?: string;
	readonly short?: string;
	readonly default?: unknown;
	readonly env?: string;
	readonly required?: boolean;
}

export interface FlagDef {
	readonly _kind: "flag";
	readonly description?: string;
	readonly short?: string;
	readonly default?: boolean | number;
	readonly counted?: boolean;
}

export interface ArgDef<TOut = unknown> {
	readonly _kind: "arg";
	/** Phantom field — only exists at the type level for inference */
	readonly _type: TOut;
	readonly type: TypeName;
	readonly name?: string;
	readonly description?: string;
	readonly required: boolean;
	readonly variadic?: boolean;
	readonly default?: unknown;
}

// ============================================================================
// Schema shape types
// ============================================================================

export type OptionsSchema = Record<string, OptionDef<any> | FlagDef>;
export type ArgsSchema = readonly ArgDef<any>[];

// ============================================================================
// Handler types
// ============================================================================

/** Metadata passed alongside parsed args to a command handler. */
export interface HandlerMeta {
	/** Tokens that appeared after `--` in the CLI input. */
	readonly passthrough: string[];
}

export type Handler<TArgs extends object = Record<string, unknown>> = (
	args: TArgs,
	ctx: CommandContext,
	meta: HandlerMeta,
) => ExecResult | Promise<ExecResult>;

// ============================================================================
// Parse error types
// ============================================================================

export type ParseError =
	| { type: "unknown_option"; name: string; suggestions: string[] }
	| { type: "invalid_type"; name: string; expected: string; received: string }
	| { type: "missing_required"; name: string; kind: "option" | "arg" }
	| { type: "unexpected_positional"; value: string; maxPositionals: number }
	| { type: "missing_value"; name: string }
	| { type: "unknown_command"; path: string; suggestions: string[] };
