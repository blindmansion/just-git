import type { ArgDef, TypeMap, TypeName } from "../types.ts";

// ============================================================================
// ArgBuilder — fluent class for positional args
//
// Args are required by default. Call .optional() to allow undefined.
// TName carries the literal arg name through the chain for typed handler access.
// THasDefault tracks whether a default was set, enabling invoke() to know
// which args can be omitted.
// ============================================================================

export class ArgBuilder<TOut, TName extends string = never, THasDefault extends boolean = false> {
	/** @internal */
	readonly _def: ArgDef<TOut>;

	constructor(def: ArgDef<TOut>) {
		this._def = def;
	}

	/** Set the positional arg name (used for named access in the handler) */
	name<const N extends string>(name: N): ArgBuilder<TOut, N, THasDefault> {
		return new ArgBuilder<TOut, N>({
			...this._def,
			name,
		} as ArgDef<TOut>) as ArgBuilder<TOut, N, THasDefault>;
	}

	/** Add a description */
	describe(text: string): ArgBuilder<TOut, TName, THasDefault> {
		return new ArgBuilder<TOut, TName>({
			...this._def,
			description: text,
		}) as ArgBuilder<TOut, TName, THasDefault>;
	}

	/** Mark as optional — adds undefined to TOut (unless already variadic/array, which defaults to []) */
	optional(): ArgBuilder<
		TOut extends readonly any[] ? TOut : TOut | undefined,
		TName,
		THasDefault
	> {
		type Result = TOut extends readonly any[] ? TOut : TOut | undefined;
		return new ArgBuilder<Result, TName>({
			...this._def,
			required: false,
		} as unknown as ArgDef<Result>) as ArgBuilder<Result, TName, THasDefault>;
	}

	/** Mark as variadic — collects all remaining positionals into an array.
	 *  If the arg is already optional, element-level undefined is stripped
	 *  (the optionality means "zero or more", not "elements can be undefined"). */
	variadic(): ArgBuilder<NonNullable<TOut>[], TName, THasDefault> {
		return new ArgBuilder<NonNullable<TOut>[], TName>({
			...this._def,
			variadic: true,
		} as unknown as ArgDef<NonNullable<TOut>[]>) as ArgBuilder<
			NonNullable<TOut>[],
			TName,
			THasDefault
		>;
	}

	/** Set a default value (also makes the arg optional at parse time) */
	default(value: TOut): ArgBuilder<TOut, TName, true> {
		return new ArgBuilder<TOut, TName>({
			...this._def,
			required: false,
			default: value,
		}) as ArgBuilder<TOut, TName, true>;
	}
}

// ============================================================================
// Entry points
// ============================================================================

function createArg<T extends TypeName>(type: T): ArgBuilder<TypeMap[T]> {
	return new ArgBuilder<TypeMap[T]>({
		_kind: "arg",
		type,
		required: true,
	} as ArgDef<TypeMap[T]>);
}

/** Create a required string positional arg */
export function string(): ArgBuilder<string> {
	return createArg("string");
}

/** Create a required number positional arg */
export function number(): ArgBuilder<number> {
	return createArg("number");
}
