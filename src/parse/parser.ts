import { findSuggestions } from "./errors.ts";
import type {
	ArgsSchema,
	FlagDef,
	OptionDef,
	OptionsSchema,
	ParseError,
	TypeName,
} from "./types.ts";

// ============================================================================
// Result type
// ============================================================================

type ParseArgsResult =
	| { ok: true; args: Record<string, unknown>; passthrough: string[] }
	| { ok: false; errors: ParseError[] };

// ============================================================================
// parseArgs — the core parsing utility
//
// Takes a flat options schema, arg definitions, and tokens.
// Returns parsed args or a list of errors. No tree walking, no help
// detection — just parsing.
// ============================================================================

export function parseArgs(
	options: OptionsSchema,
	argDefs: ArgsSchema,
	tokens: string[],
	env?: Record<string, string>,
): ParseArgsResult {
	const errors: ParseError[] = [];

	// Build lookup maps
	const longMap = new Map<string, { key: string; def: OptionDef<any> | FlagDef }>();
	const shortMap = new Map<string, { key: string; def: OptionDef<any> | FlagDef }>();

	for (const [key, def] of Object.entries(options)) {
		const longName = camelToKebab(key);
		longMap.set(longName, { key, def });
		if (def.short) {
			shortMap.set(def.short, { key, def });
		}
	}

	// Accumulators
	const result: Record<string, unknown> = {};
	const positionals: string[] = [];
	const passthrough: string[] = [];

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i]!;

		// -- separator: stop option and positional parsing. Remaining tokens
		// go exclusively into passthrough (accessible via meta.passthrough).
		if (token === "--") {
			i++;
			while (i < tokens.length) {
				passthrough.push(tokens[i]!);
				i++;
			}
			break;
		}

		// --long-name=value or --long-name value
		if (token.startsWith("--")) {
			const eqIdx = token.indexOf("=");
			let longName: string;
			let inlineValue: string | undefined;

			if (eqIdx !== -1) {
				longName = token.slice(2, eqIdx);
				inlineValue = token.slice(eqIdx + 1);
			} else {
				longName = token.slice(2);
			}

			const entry = longMap.get(longName);
			if (!entry) {
				// Check for --no-<flag> negation
				if (longName.startsWith("no-")) {
					const positiveEntry = longMap.get(longName.slice(3));
					if (positiveEntry && positiveEntry.def._kind === "flag") {
						result[positiveEntry.key] = positiveEntry.def.counted ? 0 : false;
						i++;
						continue;
					}
				}

				const allLongNames = [...longMap.keys()];
				errors.push({
					type: "unknown_option",
					name: `--${longName}`,
					suggestions: findSuggestions(longName, allLongNames).map((s) => `--${s}`),
				});
				i++;
				continue;
			}

			if (entry.def._kind === "flag") {
				if (entry.def.counted) {
					result[entry.key] = ((result[entry.key] as number) || 0) + 1;
				} else {
					result[entry.key] = true;
				}
				i++;
				continue;
			}

			// Option with value
			const rawValue = inlineValue ?? tokens[++i];
			if (rawValue === undefined) {
				errors.push({ type: "missing_value", name: entry.key });
				i++;
				continue;
			}

			const parsed = coerce(rawValue, (entry.def as OptionDef<any>).type, entry.key, errors);
			if (parsed !== undefined) {
				result[entry.key] = parsed;
			}
			i++;
			continue;
		}

		// -abc combined short flags / -o value
		if (token.startsWith("-") && token.length > 1) {
			const chars = token.slice(1);
			for (let j = 0; j < chars.length; j++) {
				const ch = chars[j]!;
				const entry = shortMap.get(ch);
				if (!entry) {
					// If there's a long option matching this character, suggest it.
					// Common when users expect single-char keys to create short flags
					// (e.g. `b: f()` creates `--b`, not `-b` — need `.alias("b")` for that).
					const suggestions: string[] = [];
					if (longMap.has(ch)) {
						suggestions.push(`--${ch}`);
					}
					errors.push({
						type: "unknown_option",
						name: `-${ch}`,
						suggestions,
					});
					continue;
				}

				if (entry.def._kind === "flag") {
					if (entry.def.counted) {
						result[entry.key] = ((result[entry.key] as number) || 0) + 1;
					} else {
						result[entry.key] = true;
					}
					continue;
				}

				// Short option with value: rest of string or next token
				const restOfString = chars.slice(j + 1);
				const rawValue = restOfString.length > 0 ? restOfString : tokens[++i];
				if (rawValue === undefined) {
					errors.push({ type: "missing_value", name: entry.key });
					break;
				}

				const parsed = coerce(rawValue, (entry.def as OptionDef<any>).type, entry.key, errors);
				if (parsed !== undefined) {
					result[entry.key] = parsed;
				}
				break; // rest was consumed as value
			}
			i++;
			continue;
		}

		// Positional argument
		positionals.push(token);
		i++;
	}

	// Assign positionals to arg definitions
	let posIdx = 0;
	for (let idx = 0; idx < argDefs.length; idx++) {
		const argDef = argDefs[idx]!;
		const argName = argDef.name ?? `arg${idx}`;

		if (argDef.variadic) {
			const values = positionals.slice(posIdx);
			if (values.length > 0) {
				result[argName] = values.map((v) => coerce(v, argDef.type, argName, errors));
			} else if (argDef.required) {
				errors.push({ type: "missing_required", name: argName, kind: "arg" });
			} else if (argDef.default !== undefined) {
				result[argName] = argDef.default;
			} else {
				// Optional variadic with no values and no explicit default → empty array
				result[argName] = [];
			}
			posIdx = positionals.length;
		} else {
			const value = positionals[posIdx];
			if (value !== undefined) {
				result[argName] = coerce(value, argDef.type, argName, errors);
				posIdx++;
			} else if (argDef.required) {
				errors.push({ type: "missing_required", name: argName, kind: "arg" });
			} else if (argDef.default !== undefined) {
				result[argName] = argDef.default;
			}
		}
	}

	// Extra positionals
	if (posIdx < positionals.length) {
		for (let j = posIdx; j < positionals.length; j++) {
			errors.push({
				type: "unexpected_positional",
				value: positionals[j]!,
				maxPositionals: argDefs.length,
			});
		}
	}

	// Apply env fallbacks and defaults for missing options/flags
	for (const [key, def] of Object.entries(options)) {
		if (result[key] === undefined) {
			if (def._kind === "flag") {
				result[key] = def.default ?? (def.counted ? 0 : false);
			} else if (def._kind === "option") {
				// Resolution order: CLI arg (already set) > env var > default > required error
				const opt = def as OptionDef<any>;
				if (opt.env && env?.[opt.env] !== undefined) {
					const parsed = coerce(env[opt.env]!, opt.type, key, errors);
					if (parsed !== undefined) {
						result[key] = parsed;
					}
				}

				if (result[key] === undefined) {
					if (opt.required && opt.default === undefined) {
						errors.push({
							type: "missing_required",
							name: key,
							kind: "option",
						});
					} else if (opt.default !== undefined) {
						result[key] = opt.default;
					}
				}
			}
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, args: result, passthrough };
}

// ============================================================================
// Value coercion
// ============================================================================

function coerce(raw: string, type: TypeName, key: string, errors: ParseError[]): unknown {
	switch (type) {
		case "string":
			return raw;
		case "number": {
			const n = Number(raw);
			if (Number.isNaN(n)) {
				errors.push({
					type: "invalid_type",
					name: key,
					expected: "number",
					received: raw,
				});
				return undefined;
			}
			return n;
		}
		case "boolean": {
			if (raw === "true" || raw === "1") return true;
			if (raw === "false" || raw === "0") return false;
			errors.push({
				type: "invalid_type",
				name: key,
				expected: "boolean",
				received: raw,
			});
			return undefined;
		}
		default:
			return raw;
	}
}

export function camelToKebab(str: string): string {
	return str.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
