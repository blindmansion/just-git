import { describe, expect, test } from "bun:test";
import { EMPTY_REPO } from "../fixtures";
import { createHookBash } from "./helpers";

describe("disabled commands", () => {
	test("disabled option blocks a command", async () => {
		const { bash } = createHookBash({ files: EMPTY_REPO }, { disabled: ["init"] });
		const result = await bash.exec("git init");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not available");
	});
});
