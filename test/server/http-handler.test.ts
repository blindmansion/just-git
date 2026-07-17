import { describe, expect, test } from "bun:test";
import type { GitRepo } from "../../src/lib/types.ts";
import { createHttpHandler, type HttpHandlerDependencies } from "../../src/server/http-handler.ts";

function dependencies(
	overrides: Partial<HttpHandlerDependencies<string>> = {},
): HttpHandlerDependencies<string> {
	return {
		resolveRepo: async () => null,
		receiveLimits: {},
		fetchLimits: {},
		auth: { http: () => "authenticated" },
		enter: () => true,
		leave: () => {},
		...overrides,
	};
}

describe("createHttpHandler", () => {
	test("rejects requests without entering when the server is closed", async () => {
		let authCalls = 0;
		let leaveCalls = 0;
		const handler = createHttpHandler(
			dependencies({
				auth: {
					http: () => {
						authCalls++;
						return "authenticated";
					},
				},
				enter: () => false,
				leave: () => {
					leaveCalls++;
				},
			}),
		);

		const response = await handler(new Request("http://localhost/repo/info/refs"));

		expect(response.status).toBe(503);
		expect(authCalls).toBe(0);
		expect(leaveCalls).toBe(0);
	});

	test("returns auth responses and always leaves entered requests", async () => {
		let leaveCalls = 0;
		const authResponse = new Response("Unauthorized", { status: 401 });
		const handler = createHttpHandler(
			dependencies({
				auth: { http: () => authResponse },
				leave: () => {
					leaveCalls++;
				},
			}),
		);

		const response = await handler(new Request("http://localhost/repo/info/refs"));

		expect(response).toBe(authResponse);
		expect(leaveCalls).toBe(1);
	});

	test("uses embedded auth and passes the base-path-stripped repo path", async () => {
		let authCalls = 0;
		let resolvedPath: string | undefined;
		const handler = createHttpHandler(
			dependencies({
				basePath: "/git",
				auth: {
					http: () => {
						authCalls++;
						return "provider";
					},
				},
				getEmbeddedAuth: () => "embedded",
				resolveRepo: async (path) => {
					resolvedPath = path;
					return null;
				},
			}),
		);

		const response = await handler(
			new Request("http://localhost/git/team/repo/info/refs?service=git-upload-pack"),
		);

		expect(response.status).toBe(404);
		expect(resolvedPath).toBe("team/repo");
		expect(authCalls).toBe(0);
	});

	test("maps request limits without reporting an internal error", async () => {
		let reportedError: unknown;
		const handler = createHttpHandler(
			dependencies({
				resolveRepo: async () => ({ repo: {} as GitRepo, repoId: "repo" }),
				fetchLimits: { maxRequestBytes: 1 },
				onError: (error) => {
					reportedError = error;
				},
			}),
		);

		const response = await handler(
			new Request("http://localhost/repo/git-upload-pack", {
				method: "POST",
				headers: { "content-length": "2" },
				body: "xx",
			}),
		);

		expect(response.status).toBe(413);
		expect(await response.text()).toBe("Request body too large");
		expect(reportedError).toBeUndefined();
	});

	test("reports unexpected errors with resolved auth and leaves", async () => {
		const failure = new Error("resolve failed");
		let reported: [unknown, string | undefined] | undefined;
		let leaveCalls = 0;
		const handler = createHttpHandler(
			dependencies({
				resolveRepo: async () => {
					throw failure;
				},
				leave: () => {
					leaveCalls++;
				},
				onError: (error, auth) => {
					reported = [error, auth];
				},
			}),
		);

		const response = await handler(
			new Request("http://localhost/repo/info/refs?service=git-upload-pack"),
		);

		expect(response.status).toBe(500);
		expect(reported).toEqual([failure, "authenticated"]);
		expect(leaveCalls).toBe(1);
	});
});
