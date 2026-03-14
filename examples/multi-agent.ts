/**
 * Multi-agent collaboration example.
 *
 * Each agent gets its own InMemoryFs — complete VFS isolation.
 * Cross-VFS communication is handled by `resolveRemote`, which
 * maps remote URLs to GitContexts on other filesystems.
 *
 * Topology:
 *   Origin (VFS-1)  <──>  Alice (VFS-2)
 *                   <──>  Bob (VFS-3)
 *                   <──>  Coordinator (VFS-4)
 *
 * Run: bun examples/multi-agent.ts
 */

import { Bash, InMemoryFs } from "just-bash";
import { createGit, findGitDir } from "../src/index.ts";

async function run() {
	// ── Step 1: Origin on its own VFS ─────────────────────────────
	const originFs = new InMemoryFs();
	const originGit = createGit({
		identity: { name: "Setup", email: "setup@example.com", locked: true },
	});
	const originBash = new Bash({
		fs: originFs,
		cwd: "/repo",
		customCommands: [originGit],
	});

	await originBash.exec("git init");
	await originBash.writeFile("/repo/README.md", "# Shared Project\n\nBuilt by agents.\n");
	await originBash.writeFile("/repo/src/index.ts", 'export const VERSION = "0.1.0";\n');
	await originBash.exec("git add .");
	await originBash.exec('git commit -m "initial commit"');

	const originCtx = await findGitDir(originFs, "/repo");
	if (!originCtx) throw new Error("origin setup failed");

	console.log("=== Origin bootstrapped on VFS-1 ===\n");

	// ── Step 2: Create agents on isolated VFS instances ───────────

	function createAgent(name: string, email: string) {
		const agentFs = new InMemoryFs();
		const git = createGit({
			identity: { name, email, locked: true },
			resolveRemote: (url) => (url === "/origin" ? originCtx : null),
		});
		const bash = new Bash({
			fs: agentFs,
			cwd: "/repo",
			customCommands: [git],
		});
		return { git, bash, name, fs: agentFs };
	}

	const alice = createAgent("Alice", "alice@agents.dev");
	const bob = createAgent("Bob", "bob@agents.dev");
	const coordinator = createAgent("Coordinator", "coord@agents.dev");

	for (const agent of [alice, bob, coordinator]) {
		const result = await agent.bash.exec("git clone /origin /repo", { cwd: "/" });
		console.log(`${agent.name} cloned (isolated VFS): ${result.stderr.trim()}`);
	}
	console.log();

	// ── Step 3: Agents work independently ─────────────────────────

	// Alice: auth module
	await alice.bash.exec("git checkout -b feature/auth");
	await alice.bash.writeFile(
		"/repo/src/auth.ts",
		[
			"export interface User { id: string; name: string; }",
			"",
			"export function authenticate(token: string): User | null {",
			'  return token === "valid" ? { id: "1", name: "Agent" } : null;',
			"}",
			"",
		].join("\n"),
	);
	await alice.bash.exec("git add .");
	await alice.bash.exec('git commit -m "feat: add auth module"');
	const alicePush = await alice.bash.exec("git push origin feature/auth");
	console.log(`Alice pushed: exit=${alicePush.exitCode}`);

	// Verify Alice's VFS is isolated — Bob can't see her files locally
	const bobHasAuthFile = await bob.bash.fs.exists("/repo/src/auth.ts");
	console.log(`Bob sees auth.ts locally? ${bobHasAuthFile} (should be false — isolated VFS)`);

	// Bob: utils module
	await bob.bash.exec("git checkout -b feature/utils");
	await bob.bash.writeFile(
		"/repo/src/utils.ts",
		[
			"export function slugify(s: string): string {",
			"  return s.toLowerCase().replace(/\\s+/g, '-');",
			"}",
			"",
		].join("\n"),
	);
	await bob.bash.exec("git add .");
	await bob.bash.exec('git commit -m "feat: add utils"');
	const bobPush = await bob.bash.exec("git push origin feature/utils");
	console.log(`Bob pushed: exit=${bobPush.exitCode}`);
	console.log();

	// ── Step 4: Coordinator merges everything ─────────────────────

	await coordinator.bash.exec("git fetch origin");

	const branches = await coordinator.bash.exec("git branch -a");
	console.log("Coordinator sees branches:");
	console.log(branches.stdout);

	await coordinator.bash.exec("git merge origin/feature/auth --no-ff -m 'Merge auth'");
	await coordinator.bash.exec("git merge origin/feature/utils --no-ff -m 'Merge utils'");
	await coordinator.bash.exec("git push origin main");

	const log = await coordinator.bash.exec("git log --oneline");
	console.log("=== Integrated history ===");
	console.log(log.stdout);

	// ── Step 5: Agents pull the integrated work ───────────────────

	await alice.bash.exec("git checkout main");
	const alicePull = await alice.bash.exec("git pull origin main");
	console.log(`Alice pulled: exit=${alicePull.exitCode}`);

	const aliceHasUtils = await alice.bash.fs.exists("/repo/src/utils.ts");
	console.log(`Alice now sees utils.ts? ${aliceHasUtils} (should be true — pulled via origin)`);

	console.log("\n=== Multi-agent isolated VFS collaboration complete ===");
}

run().catch(console.error);
