import { describe, expect, test } from "bun:test";
import { mapRefspec, parseRefspec, refspecMatches } from "../../src/lib/transport/refspec.ts";

// ── parseRefspec ─────────────────────────────────────────────────────

describe("parseRefspec", () => {
	test("simple wildcard refspec", () => {
		expect(parseRefspec("refs/heads/*:refs/remotes/origin/*")).toEqual({
			force: false,
			src: "refs/heads/*",
			dst: "refs/remotes/origin/*",
		});
	});

	test("force prefix (+)", () => {
		expect(parseRefspec("+refs/heads/*:refs/remotes/origin/*")).toEqual({
			force: true,
			src: "refs/heads/*",
			dst: "refs/remotes/origin/*",
		});
	});

	test("exact ref (no wildcard)", () => {
		expect(parseRefspec("refs/heads/main:refs/remotes/origin/main")).toEqual({
			force: false,
			src: "refs/heads/main",
			dst: "refs/remotes/origin/main",
		});
	});

	test("no colon (src-only)", () => {
		expect(parseRefspec("refs/heads/main")).toEqual({
			force: false,
			src: "refs/heads/main",
			dst: "refs/heads/main",
		});
	});

	test("force with no colon", () => {
		expect(parseRefspec("+refs/heads/main")).toEqual({
			force: true,
			src: "refs/heads/main",
			dst: "refs/heads/main",
		});
	});
});

// ── refspecMatches ────────────────────────────────────────────────────

describe("refspecMatches", () => {
	test("wildcard pattern matches simple branch", () => {
		expect(refspecMatches("refs/heads/*", "refs/heads/main")).toBe(true);
	});

	test("wildcard pattern matches nested branch", () => {
		expect(refspecMatches("refs/heads/*", "refs/heads/feature/foo")).toBe(true);
	});

	test("wildcard pattern rejects non-matching prefix", () => {
		expect(refspecMatches("refs/heads/*", "refs/tags/v1.0")).toBe(false);
	});

	test("exact pattern matches", () => {
		expect(refspecMatches("refs/heads/main", "refs/heads/main")).toBe(true);
	});

	test("exact pattern rejects different ref", () => {
		expect(refspecMatches("refs/heads/main", "refs/heads/dev")).toBe(false);
	});

	test("empty wildcard match", () => {
		expect(refspecMatches("refs/heads/*", "refs/heads/")).toBe(true);
	});
});

// ── mapRefspec ───────────────────────────────────────────────────────

describe("mapRefspec", () => {
	test("maps wildcard refspec", () => {
		const spec = parseRefspec("+refs/heads/*:refs/remotes/origin/*");
		expect(mapRefspec(spec, "refs/heads/main")).toBe("refs/remotes/origin/main");
	});

	test("maps nested branch through wildcard", () => {
		const spec = parseRefspec("+refs/heads/*:refs/remotes/origin/*");
		expect(mapRefspec(spec, "refs/heads/feature/foo")).toBe("refs/remotes/origin/feature/foo");
	});

	test("maps exact refspec", () => {
		const spec = parseRefspec("refs/heads/main:refs/remotes/origin/main");
		expect(mapRefspec(spec, "refs/heads/main")).toBe("refs/remotes/origin/main");
	});

	test("returns null for non-matching ref", () => {
		const spec = parseRefspec("+refs/heads/*:refs/remotes/origin/*");
		expect(mapRefspec(spec, "refs/tags/v1.0")).toBeNull();
	});

	test("maps tags", () => {
		const spec = parseRefspec("refs/tags/*:refs/tags/*");
		expect(mapRefspec(spec, "refs/tags/v1.0")).toBe("refs/tags/v1.0");
	});
});
