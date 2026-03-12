import { describe, expect, test } from "bun:test";
import { Bash } from "just-bash";
import { createGit } from "../../src/git";
import { validateNetworkAccess } from "../../src/lib/transport/remote";
import { BASIC_REPO } from "../fixtures";
import { createHookBash, TEST_ENV } from "./helpers";

describe("validateNetworkAccess", () => {
	test("allows everything when policy is undefined", () => {
		expect(validateNetworkAccess("https://github.com/foo/bar.git")).toBeNull();
	});

	test("allows everything when allowed field is omitted", () => {
		expect(validateNetworkAccess("https://github.com/foo/bar.git", {})).toBeNull();
	});

	test("blocks all HTTP when policy is false", () => {
		const err = validateNetworkAccess("https://github.com/foo/bar.git", false);
		expect(err).toBe("network access is disabled");
	});

	test("blocks all HTTP when allowed list is empty", () => {
		const err = validateNetworkAccess("https://github.com/foo/bar.git", { allowed: [] });
		expect(err).toBe("network access is disabled");
	});

	test("allows matching hostname", () => {
		const policy = { allowed: ["github.com"] };
		expect(validateNetworkAccess("https://github.com/foo/bar.git", policy)).toBeNull();
		expect(validateNetworkAccess("http://github.com/foo/bar.git", policy)).toBeNull();
	});

	test("blocks non-matching hostname", () => {
		const policy = { allowed: ["github.com"] };
		const err = validateNetworkAccess("https://gitlab.com/foo/bar.git", policy);
		expect(err).toContain("network policy");
		expect(err).toContain("gitlab.com");
	});

	test("allows matching URL prefix", () => {
		const policy = { allowed: ["https://github.com/myorg/"] };
		expect(validateNetworkAccess("https://github.com/myorg/repo.git", policy)).toBeNull();
		expect(validateNetworkAccess("https://github.com/myorg/other.git", policy)).toBeNull();
	});

	test("blocks non-matching URL prefix", () => {
		const policy = { allowed: ["https://github.com/myorg/"] };
		const err = validateNetworkAccess("https://github.com/other-org/repo.git", policy);
		expect(err).toContain("network policy");
	});

	test("allows exact URL match", () => {
		const policy = { allowed: ["https://github.com/myorg/repo.git"] };
		expect(validateNetworkAccess("https://github.com/myorg/repo.git", policy)).toBeNull();
	});

	test("blocks different exact URL", () => {
		const policy = { allowed: ["https://github.com/myorg/repo.git"] };
		const err = validateNetworkAccess("https://github.com/myorg/other.git", policy);
		expect(err).toContain("network policy");
	});

	test("supports multiple entries (any match allows)", () => {
		const policy = { allowed: ["github.com", "gitlab.com"] };
		expect(validateNetworkAccess("https://github.com/a.git", policy)).toBeNull();
		expect(validateNetworkAccess("https://gitlab.com/b.git", policy)).toBeNull();
		const err = validateNetworkAccess("https://bitbucket.org/c.git", policy);
		expect(err).toContain("network policy");
	});

	test("mixed hostname and prefix entries", () => {
		const policy = { allowed: ["gitlab.com", "https://github.com/myorg/"] };
		expect(validateNetworkAccess("https://gitlab.com/anything", policy)).toBeNull();
		expect(validateNetworkAccess("https://github.com/myorg/repo.git", policy)).toBeNull();
		const err = validateNetworkAccess("https://github.com/other/repo.git", policy);
		expect(err).toContain("network policy");
	});

	test("rejects malformed URLs", () => {
		const policy = { allowed: ["github.com"] };
		const err = validateNetworkAccess("not-a-url", policy);
		expect(err).toContain("network policy");
	});
});

describe("network policy integration", () => {
	test("clone to blocked HTTP URL is rejected", async () => {
		const { bash } = createHookBash(
			{ files: BASIC_REPO },
			{ network: { allowed: ["github.com"] } },
		);
		await bash.exec("git init");
		const result = await bash.exec("git clone https://blocked.example.com/repo.git /dest");
		expect(result.exitCode).toBe(128);
	});

	test("fetch from blocked remote URL is rejected", async () => {
		const { bash } = createHookBash(
			{ files: BASIC_REPO },
			{ network: { allowed: ["github.com"] } },
		);
		await bash.exec("git init");
		await bash.exec("git add . && git commit -m init");
		await bash.exec("git remote add origin https://blocked.example.com/repo.git");
		const result = await bash.exec("git fetch origin");
		expect(result.exitCode).not.toBe(0);
	});

	test("network: false blocks HTTP clone", async () => {
		const { bash } = createHookBash({ files: BASIC_REPO }, { network: false });
		await bash.exec("git init");
		const result = await bash.exec("git clone https://example.com/repo.git /dest");
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("network access is disabled");
	});

	test("network: false blocks fetch from HTTP remote", async () => {
		const { bash } = createHookBash({ files: BASIC_REPO }, { network: false });
		await bash.exec("git init");
		await bash.exec("git add . && git commit -m init");
		await bash.exec("git remote add origin https://example.com/repo.git");
		const result = await bash.exec("git fetch origin");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("network access is disabled");
	});

	test("network: false still allows local clone", async () => {
		const git = createGit({ network: false });
		const bash = new Bash({
			cwd: "/remote",
			files: { "/remote/README.md": "# Hello" },
			customCommands: [git],
			env: TEST_ENV,
		});
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "initial"');
		const result = await bash.exec("git clone /remote /local", { cwd: "/" });
		expect(result.exitCode).toBe(0);
	});
});

describe("custom fetch function", () => {
	test("custom fetch is invoked for HTTP clone", async () => {
		let fetchCalled = false;
		let fetchedUrl = "";
		const customFetch = async (input: string | URL | Request) => {
			fetchCalled = true;
			fetchedUrl =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			return new Response("", { status: 404 });
		};

		const git = createGit({ network: { fetch: customFetch } });
		const bash = new Bash({
			cwd: "/repo",
			files: BASIC_REPO,
			customCommands: [git],
			env: TEST_ENV,
		});
		await bash.exec("git init");
		await bash.exec("git clone https://example.com/repo.git /dest");

		expect(fetchCalled).toBe(true);
		expect(fetchedUrl).toContain("example.com");
	});

	test("custom fetch is invoked for fetch command", async () => {
		let fetchCalled = false;
		const customFetch = async () => {
			fetchCalled = true;
			return new Response("", { status: 404 });
		};

		const git = createGit({ network: { fetch: customFetch } });
		const bash = new Bash({
			cwd: "/repo",
			files: BASIC_REPO,
			customCommands: [git],
			env: TEST_ENV,
		});
		await bash.exec("git init");
		await bash.exec("git add . && git commit -m init");
		await bash.exec("git remote add origin https://example.com/repo.git");
		await bash.exec("git fetch origin");

		expect(fetchCalled).toBe(true);
	});
});
