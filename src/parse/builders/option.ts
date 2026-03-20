import type { OptionDef, TypeMap, TypeName } from "../types.ts";

// ============================================================================
// OptionBuilder — fluent class with two type parameters
//
// TOut tracks the value type. THasDefault tracks whether a default was set,
// enabling the invoke() signature to distinguish required vs defaulted options.
// ============================================================================

export class OptionBuilder<TOut, THasDefault extends boolean = false> {
	/** @internal */
	readonly _def: OptionDef<TOut>;

	constructor(def: OptionDef<TOut>) {
		this._def = def;
	}

	/** Add a description */
	describe(text: string): OptionBuilder<TOut, THasDefault> {
		return new OptionBuilder({
			...this._def,
			description: text,
		}) as OptionBuilder<TOut, THasDefault>;
	}

	/** Set a short alias (single character, e.g. "p" for -p) */
	alias(short: string): OptionBuilder<TOut, THasDefault> {
		return new OptionBuilder({ ...this._def, short }) as OptionBuilder<TOut, THasDefault>;
	}

	/** Set an environment variable fallback */
	env(name: string): OptionBuilder<TOut, THasDefault> {
		return new OptionBuilder({ ...this._def, env: name }) as OptionBuilder<TOut, THasDefault>;
	}

	/** Mark as required — removes undefined from TOut */
	required(): OptionBuilder<Exclude<TOut, undefined>> {
		return new OptionBuilder({
			...this._def,
			required: true,
		} as unknown as OptionDef<Exclude<TOut, undefined>>);
	}

	/** Set a default value — removes undefined from TOut */
	default(value: Exclude<TOut, undefined>): OptionBuilder<Exclude<TOut, undefined>, true> {
		return new OptionBuilder({
			...this._def,
			default: value,
		} as unknown as OptionDef<Exclude<TOut, undefined>>) as unknown as OptionBuilder<
			Exclude<TOut, undefined>,
			true
		>;
	}

	/** Allow multiple values — accumulates into an array, defaults to [] */
	repeatable(): OptionBuilder<Exclude<TOut, undefined>[], true> {
		return new OptionBuilder({
			...this._def,
			repeatable: true,
			default: [],
		} as unknown as OptionDef<Exclude<TOut, undefined>[]>) as unknown as OptionBuilder<
			Exclude<TOut, undefined>[],
			true
		>;
	}
}

// ============================================================================
// Entry points
// ============================================================================

function createOption<T extends TypeName>(type: T): OptionBuilder<TypeMap[T] | undefined> {
	return new OptionBuilder<TypeMap[T] | undefined>({
		_kind: "option",
		type,
	} as OptionDef<TypeMap[T] | undefined>);
}

/** Create a string option (optional by default) */
export function string(): OptionBuilder<string | undefined> {
	return createOption("string");
}

/** Create a number option (optional by default) */
export function number(): OptionBuilder<number | undefined> {
	return createOption("number");
}
