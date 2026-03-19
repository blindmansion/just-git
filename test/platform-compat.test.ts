import { describe, test, expect, beforeAll } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

describe("platform compatibility", () => {
	beforeAll(async () => {
		const build = Bun.spawn(["bun", "run", "build"], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		await build.exited;
		if (build.exitCode !== 0) {
			const stderr = await new Response(build.stderr).text();
			throw new Error(`bun run build failed:\n${stderr}`);
		}
	}, 30_000);

	test("node: server clone + push", async () => {
		if (!Bun.which("node")) {
			console.log("  skipped: node not installed");
			return;
		}

		const proc = Bun.spawn(["node", "examples/node-server.mjs"], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		if (proc.exitCode !== 0) {
			console.log("stdout:", stdout);
			console.log("stderr:", stderr);
		}
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("All passed on Node");
	}, 30_000);

	test("deno: server clone + push", async () => {
		if (!Bun.which("deno")) {
			console.log("  skipped: deno not installed");
			return;
		}

		const proc = Bun.spawn(["deno", "run", "--allow-all", "examples/deno-server.mjs"], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		if (proc.exitCode !== 0) {
			console.log("stdout:", stdout);
			console.log("stderr:", stderr);
		}
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("All passed on Deno");
	}, 30_000);
});
