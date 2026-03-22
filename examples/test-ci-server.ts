/**
 * End-to-end test: CI server with ephemeral worktrees in server hooks.
 *
 * Uses the HTTP transport: client pushes to the server via fetch handler,
 * server hooks spin up ephemeral worktrees to inspect code before accepting.
 */

import { MemoryFileSystem } from "../src/memory-fs.ts";
import { createGit } from "../src/git.ts";
import { MemoryDriver } from "../src/server/memory-storage.ts";
import { createGitServer } from "../src/server/handler.ts";
import { readFileAtCommit, grep, resolveRef } from "../src/repo";
import { createSandboxWorktree } from "../src/repo/helpers.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.log(`  ✗ ${msg}`);
		failed++;
	}
}

// ── Server setup ────────────────────────────────────────────────────

const ciLog: string[] = [];

const server = createGitServer({
	storage: new MemoryDriver(),
	autoCreate: true,
	hooks: {
		async preReceive({ repo, updates }) {
			for (const update of updates) {
				if (update.isDelete) continue;

				ciLog.push(`CI: checking ${update.ref} → ${update.newHash.slice(0, 8)}`);

				// Check 1: no FIXMEs (uses pure object-store grep)
				const fixmeResults = await grep(repo, update.newHash, ["FIXME"]);
				if (fixmeResults.length > 0) {
					const files = fixmeResults.map((r) => r.path).join(", ");
					ciLog.push(`CI: REJECTED — FIXME found in: ${files}`);
					return { reject: true, message: `FIXME found in: ${files}` };
				}

				// Check 2: package.json has test script
				const pkg = await readFileAtCommit(repo, update.newHash, "package.json");
				if (pkg) {
					try {
						const parsed = JSON.parse(pkg);
						if (!parsed.scripts?.test) {
							ciLog.push(`CI: REJECTED — missing scripts.test`);
							return { reject: true, message: "package.json missing scripts.test" };
						}
					} catch {
						ciLog.push(`CI: REJECTED — invalid package.json`);
						return { reject: true, message: "invalid package.json" };
					}
				}

				// Check 3: full ephemeral worktree build check
				const { ctx } = await createSandboxWorktree(repo, {
					ref: update.newHash,
					workTree: `/ci-${update.newHash.slice(0, 8)}`,
				});

				// Read .ts files from the lazy filesystem
				let srcEntries: string[] = [];
				try {
					srcEntries = await ctx.fs.readdir(`${ctx.workTree}/src`);
				} catch {
					// no src dir is fine
				}

				for (const entry of srcEntries) {
					if (entry.endsWith(".ts")) {
						const content = await ctx.fs.readFile(`${ctx.workTree}/src/${entry}`);
						if (content.includes("SYNTAX_ERROR")) {
							ciLog.push(`CI: REJECTED — syntax error in src/${entry}`);
							return { reject: true, message: `build failed: syntax error in src/${entry}` };
						}
					}
				}

				// Verify we can write temp files in the ephemeral context
				await ctx.fs.mkdir(`${ctx.workTree}/tmp`, { recursive: true });
				await ctx.fs.writeFile(`${ctx.workTree}/tmp/ci.log`, "pass\n");

				// Use git in the ephemeral worktree — gitDir skips findRepo
				const ephGit = createGit({
					objectStore: ctx.objectStore,
					refStore: ctx.refStore,
					fs: ctx.fs,
					cwd: ctx.workTree!,
					gitDir: ctx.gitDir,
					identity: { name: "CI", email: "ci@test.com" },
				});
				const logResult = await ephGit.exec("log --oneline -3");
				ciLog.push(`CI: git log output: ${logResult.stdout.trim()}`);

				ciLog.push(`CI: PASSED`);
			}
		},
	},
});

// Helper: create a client repo and push to the server via HTTP
async function createClientAndPush(
	repoName: string,
	files: Record<string, string>,
	commitMsg: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const clientFs = new MemoryFileSystem();
	const remoteUrl = `http://localhost/${repoName}`;

	const clientGit = createGit({
		fs: clientFs,
		cwd: "/work",
		identity: { name: "Dev", email: "dev@test.com" },
		network: {
			allowed: ["localhost"],
			fetch: (input, init) => {
				// Route HTTP requests to our in-process server handler
				const req = new Request(input as string, init);
				return server.fetch(req);
			},
		},
	});

	await clientGit.exec("init /work");

	for (const [path, content] of Object.entries(files)) {
		// Ensure parent dirs exist
		const dir = path.slice(0, path.lastIndexOf("/"));
		if (dir) await clientFs.mkdir(`/work/${dir}`, { recursive: true });
		await clientFs.writeFile(`/work/${path}`, content);
	}

	await clientGit.exec("add .");
	await clientGit.exec(`commit -m "${commitMsg}"`);
	await clientGit.exec(`remote add origin ${remoteUrl}`);

	return clientGit.exec("push origin main");
}

// ── Test 1: push that passes CI ─────────────────────────────────────

console.log("Test 1: push that passes all CI checks");
{
	ciLog.length = 0;

	const result = await createClientAndPush(
		"good-app",
		{
			"package.json":
				JSON.stringify(
					{
						name: "good-app",
						scripts: { test: "echo ok", build: "echo ok" },
					},
					null,
					2,
				) + "\n",
			"src/index.ts": 'export const main = () => "hello";\n',
			"src/utils.ts": "export const add = (a: number, b: number) => a + b;\n",
			"README.md": "# Good App\n",
		},
		"initial: clean project",
	);

	assert(result.exitCode === 0, `push succeeds (exit ${result.exitCode})`);
	assert(
		ciLog.some((l) => l.includes("PASSED")),
		"CI log shows PASSED",
	);
	assert(
		ciLog.some((l) => l.includes("git log output")),
		"CI ran git log in ephemeral worktree",
	);

	const goodAppRepo = await server.repo("good-app");
	assert(goodAppRepo !== null, "server has good-app repo");
	const serverRef = await goodAppRepo!.refStore.readRef("refs/heads/main");
	assert(serverRef !== null, "server has refs/heads/main");
}
console.log();

// ── Test 2: push rejected — FIXME in code ───────────────────────────

console.log("Test 2: push rejected — FIXME in code");
{
	ciLog.length = 0;

	const result = await createClientAndPush(
		"fixme-app",
		{
			"package.json":
				JSON.stringify({
					name: "fixme-app",
					scripts: { test: "echo test" },
				}) + "\n",
			"src/index.ts": "// FIXME: broken thing here\nexport const x = 1;\n",
		},
		"has fixme",
	);

	assert(result.exitCode !== 0, "push rejected");
	assert(
		ciLog.some((l) => l.includes("FIXME")),
		"CI log mentions FIXME",
	);

	const fixmeRepo = await server.repo("fixme-app");
	assert(fixmeRepo !== null, "server has fixme-app repo (auto-created)");
	const fixmeRef = await fixmeRepo!.refStore.readRef("refs/heads/main");
	assert(fixmeRef === null, "server does not have ref after rejection");
}
console.log();

// ── Test 3: push rejected — missing test script ─────────────────────

console.log("Test 3: push rejected — missing test script");
{
	ciLog.length = 0;

	const result = await createClientAndPush(
		"no-test-app",
		{
			"package.json":
				JSON.stringify({
					name: "no-test-app",
					scripts: { build: "echo build" },
				}) + "\n",
			"src/index.ts": "export const x = 1;\n",
		},
		"no test script",
	);

	assert(result.exitCode !== 0, "push rejected");
	assert(
		ciLog.some((l) => l.includes("scripts.test")),
		"CI log mentions missing test script",
	);
}
console.log();

// ── Test 4: push rejected — build check via ephemeral worktree ──────

console.log("Test 4: push rejected — syntax error caught by ephemeral worktree");
{
	ciLog.length = 0;

	const result = await createClientAndPush(
		"broken-build",
		{
			"package.json":
				JSON.stringify({
					name: "broken-build",
					scripts: { test: "echo test" },
				}) + "\n",
			"src/index.ts": "export const x = 1;\n",
			"src/broken.ts": "// This has SYNTAX_ERROR in it\n",
		},
		"broken build",
	);

	assert(result.exitCode !== 0, "push rejected");
	assert(
		ciLog.some((l) => l.includes("syntax error")),
		"CI log mentions syntax error",
	);
	assert(
		ciLog.some((l) => l.includes("broken.ts")),
		"CI identifies the broken file",
	);
}
console.log();

// ── Test 5: second push to existing repo ────────────────────────────

console.log("Test 5: second push (incremental) to existing repo");
{
	ciLog.length = 0;

	const clientFs = new MemoryFileSystem();
	const remoteUrl = "http://localhost/good-app";

	const clientGit = createGit({
		fs: clientFs,
		cwd: "/work5",
		identity: { name: "Dev", email: "dev@test.com" },
		network: {
			allowed: ["localhost"],
			fetch: (input, init) => server.fetch(new Request(input as string, init)),
		},
	});

	// Clone from server first
	await clientGit.exec(`clone ${remoteUrl} /work5`);

	// Make changes
	await clientFs.writeFile("/work5/src/new-feature.ts", "export const feature = true;\n");
	await clientGit.exec("add .");
	await clientGit.exec('commit -m "add new feature"');

	const result = await clientGit.exec("push origin main");
	assert(result.exitCode === 0, `incremental push succeeds (exit ${result.exitCode})`);
	assert(
		ciLog.some((l) => l.includes("PASSED")),
		"CI passes on incremental push",
	);
	assert(
		ciLog.some((l) => l.includes("add new feature")),
		"CI git log shows new commit message",
	);
}
console.log();

// ── Test 6: storage isolation ───────────────────────────────────────

console.log("Test 6: storage isolation — CI artifacts don't leak");
{
	const goodApp = (await server.repo("good-app"))!;
	const mainHash = await resolveRef(goodApp, "refs/heads/main");
	assert(mainHash !== null, "good-app main ref still exists");

	// Verify the pushed content is correct
	const content = await readFileAtCommit(goodApp, mainHash!, "src/index.ts");
	assert(content !== null && content.includes("hello"), "good-app has correct content");

	const newFeature = await readFileAtCommit(goodApp, mainHash!, "src/new-feature.ts");
	assert(newFeature !== null && newFeature.includes("feature"), "incremental push content present");

	// Rejected repos should not have any refs
	for (const name of ["fixme-app", "no-test-app", "broken-build"]) {
		const r = (await server.repo(name))!;
		const refs = await r.refStore.listRefs();
		const nonHeadRefs = refs.filter((ref) => ref.name !== "HEAD");
		assert(nonHeadRefs.length === 0, `${name} has no refs (push was rejected)`);
	}
}
console.log();

// ── Summary ─────────────────────────────────────────────────────────

console.log("─────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
} else {
	console.log("All tests passed!");
}
