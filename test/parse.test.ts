import { describe, expect, test } from "bun:test";
import { f, o } from "../src/parse/index.ts";
import { parseArgs } from "../src/parse/parser.ts";
import type { ArgDef } from "../src/parse/types.ts";

/**
 * Unit tests for parseArgs, focused on optional-value options
 * (impliedValue — git's PARSE_OPT_OPTARG style, e.g. `status -u[<mode>]`).
 */

const pathspec: ArgDef<string[]> = {
	_kind: "arg",
	_type: [] as string[],
	type: "string",
	name: "pathspec",
	required: false,
	variadic: true,
};

function schema() {
	return {
		mode: o.string().alias("u").impliedValue("all")._def,
		verbose: f().alias("v")._def,
	};
}

function parse(tokens: string[]) {
	const result = parseArgs(schema(), [pathspec], tokens);
	if (!result.ok) throw new Error(`parse failed: ${JSON.stringify(result.errors)}`);
	return result.args;
}

describe("parseArgs optional-value options (impliedValue)", () => {
	test("bare short option takes the implied value", () => {
		expect(parse(["-u"]).mode).toBe("all");
	});

	test("bare long option takes the implied value", () => {
		expect(parse(["--mode"]).mode).toBe("all");
	});

	test("attached short value wins over the implied value", () => {
		expect(parse(["-uno"]).mode).toBe("no");
	});

	test("--opt=value wins over the implied value", () => {
		expect(parse(["--mode=no"]).mode).toBe("no");
	});

	test("bare short option does not consume the next token", () => {
		const args = parse(["-u", "-v"]);
		expect(args.mode).toBe("all");
		expect(args.verbose).toBe(true);
	});

	test("bare long option does not consume a following positional", () => {
		const args = parse(["--mode", "somefile"]);
		expect(args.mode).toBe("all");
		expect(args.pathspec).toEqual(["somefile"]);
	});

	test("works at the end of a combined short-flag group", () => {
		const args = parse(["-vu"]);
		expect(args.verbose).toBe(true);
		expect(args.mode).toBe("all");
	});

	test("options without impliedValue still consume the next token", () => {
		const plain = { mode: o.string().alias("u")._def };
		const result = parseArgs(plain, [], ["-u", "no"]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.args.mode).toBe("no");
	});

	test("options without impliedValue still error when the value is missing", () => {
		const plain = { mode: o.string().alias("u")._def };
		const result = parseArgs(plain, [], ["-u"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]?.type).toBe("missing_value");
	});
});
