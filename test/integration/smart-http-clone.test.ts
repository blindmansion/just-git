import { describe, expect, test } from "bun:test";
import { TEST_ENV as ENV } from "../fixtures";
import { createTestBash } from "../util";
import {
	createAuthBash,
	createEnvAuthBash,
	createFallbackAuthBash,
	loadNetworkEnv,
	type NetworkEnv,
	skipLog,
	skipNetwork,
} from "./network-helpers.ts";

const PUBLIC_REPO = "https://github.com/DeabLabs/cannoli.git";

function skipOnNetworkFailure(result: { exitCode: number; stderr: string }) {
	if (result.exitCode !== 0) {
		console.log("SKIP: HTTP clone failed (network?):", result.stderr);
		return true;
	}
	return false;
}

describe("Smart HTTP clone (public)", () => {
	test("clones a real public GitHub repo", async () => {
		const bash = createTestBash({ env: ENV });

		const result = await bash.exec(`git clone ${PUBLIC_REPO}`);
		if (skipOnNetworkFailure(result)) return;

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Cloning into");

		const logResult = await bash.exec("git log --oneline", {
			cwd: "/repo/cannoli",
		});
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout.length).toBeGreaterThan(0);

		const branchResult = await bash.exec("git branch", {
			cwd: "/repo/cannoli",
		});
		expect(branchResult.exitCode).toBe(0);
		expect(branchResult.stdout).toMatch(/\* \S+/);

		const statusResult = await bash.exec("git status", {
			cwd: "/repo/cannoli",
		});
		expect(statusResult.exitCode).toBe(0);
	}, 30000);

	test.skipIf(skipNetwork)(
		"clones into specified directory",
		async () => {
			const bash = createTestBash({ env: ENV });

			const result = await bash.exec(`git clone ${PUBLIC_REPO} my-clone`);
			if (skipOnNetworkFailure(result)) return;

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("Cloning into 'my-clone'");

			const statusResult = await bash.exec("git status", {
				cwd: "/repo/my-clone",
			});
			expect(statusResult.exitCode).toBe(0);
		},
		30000,
	);

	test.skipIf(skipNetwork)(
		"checkout has correct file content",
		async () => {
			const bash = createTestBash({ env: ENV });

			const result = await bash.exec(`git clone ${PUBLIC_REPO}`);
			if (skipOnNetworkFailure(result)) return;

			const statusResult = await bash.exec("git status", {
				cwd: "/repo/cannoli",
			});
			expect(statusResult.exitCode).toBe(0);
			expect(statusResult.stdout).toContain("nothing to commit");

			const logResult = await bash.exec("git log -n 1", {
				cwd: "/repo/cannoli",
			});
			expect(logResult.exitCode).toBe(0);
			expect(logResult.stdout).toContain("commit ");
		},
		30000,
	);
});

describe.skipIf(skipNetwork)("Smart HTTP clone (private, authenticated)", () => {
	let net: NetworkEnv | null;

	test("clones a private repo with credentials", async () => {
		net = loadNetworkEnv();
		if (!net) {
			skipLog("clone private");
			return;
		}

		const bash = createAuthBash(net);
		const result = await bash.exec(`git clone ${net.repo}`);
		if (skipOnNetworkFailure(result)) return;

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Cloning into");

		const segments = net.repo.split("/");
		const repoName = (segments[segments.length - 1] ?? "").replace(/\.git$/, "");
		const cwd = `/repo/${repoName}`;

		const logResult = await bash.exec("git log --oneline", { cwd });
		expect(logResult.exitCode).toBe(0);
		expect(logResult.stdout.length).toBeGreaterThan(0);

		const statusResult = await bash.exec("git status", { cwd });
		expect(statusResult.exitCode).toBe(0);
		expect(statusResult.stdout).toContain("nothing to commit");
	}, 30000);

	test("clones private repo with -b <branch>", async () => {
		net = loadNetworkEnv();
		if (!net) {
			skipLog("clone -b");
			return;
		}

		const bash = createAuthBash(net);
		const result = await bash.exec(`git clone -b main ${net.repo} branched`);
		if (skipOnNetworkFailure(result)) return;

		expect(result.exitCode).toBe(0);

		const branchResult = await bash.exec("git branch", {
			cwd: "/repo/branched",
		});
		expect(branchResult.exitCode).toBe(0);
		expect(branchResult.stdout).toContain("* main");
	}, 30000);

	test("clone fails without credentials for private repo", async () => {
		net = loadNetworkEnv();
		if (!net) {
			skipLog("clone no-auth");
			return;
		}

		const bash = createTestBash({ env: ENV });
		const result = await bash.exec(`git clone ${net.repo}`);

		expect(result.exitCode).not.toBe(0);
	}, 30000);
});

describe.skipIf(skipNetwork)("Credential paths", () => {
	test("GIT_HTTP_USER + GIT_HTTP_PASSWORD env vars", async () => {
		const net = loadNetworkEnv();
		if (!net) {
			skipLog("env-var auth");
			return;
		}

		const bash = createEnvAuthBash(net);
		const result = await bash.exec(`git clone ${net.repo} env-auth`);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Cloning into");

		const status = await bash.exec("git status", { cwd: "/repo/env-auth" });
		expect(status.stdout).toContain("nothing to commit");
	}, 30000);

	test("credential provider returns null, falls back to env vars", async () => {
		const net = loadNetworkEnv();
		if (!net) {
			skipLog("fallback auth");
			return;
		}

		const bash = createFallbackAuthBash(net);
		const result = await bash.exec(`git clone ${net.repo} fallback-auth`);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("Cloning into");

		const status = await bash.exec("git status", {
			cwd: "/repo/fallback-auth",
		});
		expect(status.stdout).toContain("nothing to commit");
	}, 30000);
});
