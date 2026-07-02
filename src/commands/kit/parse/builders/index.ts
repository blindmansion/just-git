import { number as aNumber, string as aString } from "./arg.ts";
import { FlagBuilder } from "./flag.ts";
import { number as oNumber, string as oString } from "./option.ts";

// ============================================================================
// Namespaced entry points: o.string(), o.number(), f(), a.string(), a.number()
// ============================================================================

/** Option builders */
export const o = {
	string: oString,
	number: oNumber,
} as const;

/** Flag builder */
export function f(): FlagBuilder {
	return new FlagBuilder();
}

/** Arg builders */
export const a = {
	string: aString,
	number: aNumber,
} as const;
