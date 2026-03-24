import { describe, expect, test } from "bun:test";
import { parseRemoteUrl, type CredentialCache } from "../../src/lib/transport/remote.ts";
import type { HttpAuth } from "../../src/lib/transport/transport.ts";

describe("parseRemoteUrl", () => {
	test("passes through plain HTTPS URL unchanged", () => {
		const result = parseRemoteUrl("https://github.com/org/repo.git");
		expect(result.url).toBe("https://github.com/org/repo.git");
		expect(result.embeddedAuth).toBeUndefined();
	});

	test("passes through plain HTTP URL unchanged", () => {
		const result = parseRemoteUrl("http://example.com/repo.git");
		expect(result.url).toBe("http://example.com/repo.git");
		expect(result.embeddedAuth).toBeUndefined();
	});

	test("extracts user:password from HTTPS URL", () => {
		const result = parseRemoteUrl("https://user:token123@github.com/org/repo.git");
		expect(result.url).toBe("https://github.com/org/repo.git");
		expect(result.embeddedAuth).toEqual({
			type: "basic",
			username: "user",
			password: "token123",
		});
	});

	test("extracts username-only from HTTPS URL", () => {
		const result = parseRemoteUrl("https://user@github.com/org/repo.git");
		expect(result.url).toBe("https://github.com/org/repo.git");
		expect(result.embeddedAuth).toEqual({
			type: "basic",
			username: "user",
			password: "",
		});
	});

	test("decodes URL-encoded characters in credentials", () => {
		const result = parseRemoteUrl("https://user%40name:p%40ss%3Aword@github.com/repo.git");
		expect(result.url).toBe("https://github.com/repo.git");
		expect(result.embeddedAuth).toEqual({
			type: "basic",
			username: "user@name",
			password: "p@ss:word",
		});
	});

	test("preserves port in sanitized URL", () => {
		const result = parseRemoteUrl("https://user:pass@example.com:8443/repo.git");
		expect(result.url).toBe("https://example.com:8443/repo.git");
		expect(result.embeddedAuth).toBeDefined();
	});

	test("preserves query string in sanitized URL", () => {
		const result = parseRemoteUrl("https://user:pass@example.com/repo.git?ref=main");
		expect(result.url).toBe("https://example.com/repo.git?ref=main");
		expect(result.embeddedAuth).toBeDefined();
	});

	test("passes through non-HTTP URL unchanged", () => {
		const result = parseRemoteUrl("/local/path/to/repo");
		expect(result.url).toBe("/local/path/to/repo");
		expect(result.embeddedAuth).toBeUndefined();
	});

	test("passes through SSH URL unchanged", () => {
		const result = parseRemoteUrl("git@github.com:org/repo.git");
		expect(result.url).toBe("git@github.com:org/repo.git");
		expect(result.embeddedAuth).toBeUndefined();
	});

	test("passes through ssh:// URL unchanged", () => {
		const result = parseRemoteUrl("ssh://git@github.com/org/repo.git");
		expect(result.url).toBe("ssh://git@github.com/org/repo.git");
		expect(result.embeddedAuth).toBeUndefined();
	});

	test("passes through malformed HTTP URL unchanged", () => {
		const result = parseRemoteUrl("https://");
		expect(result.url).toBe("https://");
		expect(result.embeddedAuth).toBeUndefined();
	});

	test("handles HTTP URL with embedded creds", () => {
		const result = parseRemoteUrl("http://user:pass@localhost:3000/repo.git");
		expect(result.url).toBe("http://localhost:3000/repo.git");
		expect(result.embeddedAuth).toEqual({
			type: "basic",
			username: "user",
			password: "pass",
		});
	});
});

describe("CredentialCache", () => {
	test("stores and retrieves by origin", () => {
		const cache: CredentialCache = new Map();
		const auth: HttpAuth = { type: "bearer", token: "abc123" };
		cache.set("https://github.com", auth);
		expect(cache.get("https://github.com")).toBe(auth);
	});

	test("different paths on same origin share credentials", () => {
		const cache: CredentialCache = new Map();
		const auth: HttpAuth = { type: "basic", username: "u", password: "p" };
		const origin = new URL("https://github.com/org/repo.git").origin;
		cache.set(origin, auth);

		const lookupOrigin = new URL("https://github.com/other/repo2.git").origin;
		expect(cache.get(lookupOrigin)).toBe(auth);
	});

	test("different origins are independent", () => {
		const cache: CredentialCache = new Map();
		const auth1: HttpAuth = { type: "bearer", token: "token1" };
		const auth2: HttpAuth = { type: "bearer", token: "token2" };
		cache.set("https://github.com", auth1);
		cache.set("https://gitlab.com", auth2);

		expect(cache.get("https://github.com")).toBe(auth1);
		expect(cache.get("https://gitlab.com")).toBe(auth2);
	});

	test("different ports are independent origins", () => {
		const cache: CredentialCache = new Map();
		const auth1: HttpAuth = { type: "bearer", token: "t1" };
		const auth2: HttpAuth = { type: "bearer", token: "t2" };
		cache.set(new URL("https://example.com:443/repo").origin, auth1);
		cache.set(new URL("https://example.com:8443/repo").origin, auth2);

		expect(cache.get(new URL("https://example.com:8443/repo").origin)).toBe(auth2);
	});

	test("returns undefined for unknown origin", () => {
		const cache: CredentialCache = new Map();
		expect(cache.get("https://unknown.com")).toBeUndefined();
	});
});
