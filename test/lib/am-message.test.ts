import { describe, expect, test } from "bun:test";
import { prepareAmMessage, shouldSkipAmCommit } from "../../src/lib/patch/am-message.ts";

const PATCH_MESSAGE =
	"From: Patch Author <author@example.com>\n" +
	"Date: Thu, 1 Jan 2009 00:00:00 +0000\n" +
	"Subject: [PATCH] change value\n\n" +
	"Body text.\n\n" +
	"---\n" +
	"diff --git a/value.txt b/value.txt\n" +
	"--- a/value.txt\n" +
	"+++ b/value.txt\n" +
	"@@ -1 +1 @@\n" +
	"-old\n" +
	"+new\n";

describe("prepareAmMessage", () => {
	test("shares mail parsing, message assembly, signoff, and patch parsing", () => {
		const result = prepareAmMessage(PATCH_MESSAGE, {
			signoffLine: "Signed-off-by: Committer <committer@example.com>",
		});

		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw new Error("unreachable");
		expect(result.prepared.mail.subject).toBe("change value");
		expect(result.prepared.message).toBe(
			"change value\n\nBody text.\n\nSigned-off-by: Committer <committer@example.com>\n",
		);
		expect(result.prepared.patches).toHaveLength(1);
		expect(result.prepared.patches[0]?.newName).toBe("value.txt");
	});

	test("classifies empty and corrupt patches before either shell handles the stop", () => {
		const empty = prepareAmMessage(
			"From: A <a@example.com>\nSubject: [PATCH] empty\n\nmessage only\n",
		);
		expect(empty.status).toBe("empty");

		const corrupt = prepareAmMessage(PATCH_MESSAGE.replace("@@ -1 +1 @@", "@@ -oops +1 @@"));
		expect(corrupt.status).toBe("parse-error");
		if (corrupt.status !== "parse-error") throw new Error("unreachable");
		expect(corrupt.line).toBeGreaterThan(0);
	});
});

describe("shouldSkipAmCommit", () => {
	test("only skips a tree-equal result reached through three-way fallback", () => {
		expect(shouldSkipAmCommit(false, false)).toBe(false);
		expect(shouldSkipAmCommit(false, true)).toBe(false);
		expect(shouldSkipAmCommit(true, false)).toBe(false);
		expect(shouldSkipAmCommit(true, true)).toBe(true);
	});
});
