/**
 * Build dist/ and serve the browser smoke test.
 *
 * Usage: bun test/smoke/serve-browser-test.ts
 */

import { $ } from "bun";

console.log("Building…");
const build = await $`bun run build`.quiet();
if (build.exitCode !== 0) {
	console.error(build.stderr.toString());
	process.exit(1);
}
console.log("Build OK\n");

const srv = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		let path = url.pathname;
		if (path === "/") path = "/test/smoke/browser-test.html";

		const file = Bun.file(import.meta.dir + "/../../" + path);
		if (!(await file.exists())) return new Response("Not found", { status: 404 });
		return new Response(file);
	},
});

console.log(`Browser smoke test → http://localhost:${srv.port}`);
