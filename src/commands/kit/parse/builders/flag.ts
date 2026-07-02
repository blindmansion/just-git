import type { FlagDef } from "../types.ts";

// ============================================================================
// FlagBuilder — TCounted tracks whether .count() has been called
// ============================================================================

export class FlagBuilder<TCounted extends boolean = false> {
	/** @internal */
	readonly _def: FlagDef;

	constructor(def: FlagDef = { _kind: "flag" }) {
		this._def = def;
	}

	/** Add a description */
	describe(text: string): FlagBuilder<TCounted> {
		return new FlagBuilder({ ...this._def, description: text });
	}

	/** Set a short alias (single character, e.g. "v" for -v) */
	alias(short: string): FlagBuilder<TCounted> {
		return new FlagBuilder({ ...this._def, short });
	}

	/** Set a default value */
	default(value: TCounted extends true ? number : boolean): FlagBuilder<TCounted> {
		return new FlagBuilder({ ...this._def, default: value });
	}

	/**
	 * Enable counting mode. Repeated occurrences (-v -v or -vv) produce a
	 * number instead of a boolean: 0 (absent), 1, 2, 3, etc.
	 */
	count(): FlagBuilder<true> {
		return new FlagBuilder({ ...this._def, counted: true });
	}
}
