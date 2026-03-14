/**
 * Multi-agent collaboration example.
 *
 * Three independent agents share a codebase via a bare "origin" repo.
 * Each agent has its own Bash + Git instance, works on a separate branch,
 * and pushes to origin. A coordinator agent merges everything together.
 *
 * All of this happens in-memory on a single shared virtual filesystem.
 * No network, no disk, no external git server.
 */

import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../src/index.ts";

function agentEnv(name: string, email: string, ts: number) {
	return {
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: name,
		GIT_COMMITTER_EMAIL: email,
		GIT_AUTHOR_DATE: String(ts),
		GIT_COMMITTER_DATE: String(ts),
	};
}

async function run() {
	// ── Shared virtual filesystem ──────────────────────────────────
	const fs = new InMemoryFs();

	// ── Step 1: Bootstrap the origin repo ─────────────────────────
	// We create the origin as a regular repo. LocalTransport only
	// touches objects and refs, so the working tree is irrelevant.
	const setupGit = createGit();
	const setup = new Bash({
		fs,
		cwd: "/origin",
		customCommands: [setupGit],
	});

	await setup.exec("git init");
	await setup.writeFile("/origin/README.md", "# Shared Project\n\nBuilt by agents.\n");
	await setup.writeFile("/origin/src/index.ts", 'export const VERSION = "0.1.0";\n');
	await setup.exec("git add .");
	await setup.exec('git commit -m "initial commit"', {
		env: agentEnv("Setup", "setup@example.com", 1000000000),
	});

	console.log("=== Origin repo bootstrapped ===\n");

	// ── Step 2: Create agent environments ─────────────────────────
	// Each agent gets its own Git instance (hooks, identity, middleware)
	// but they all share the same filesystem.

	function createAgent(name: string, email: string, workDir: string) {
		const git = createGit({
			identity: { name, email },
		});

		const bash = new Bash({
			fs,
			cwd: workDir,
			customCommands: [git],
		});

		return { git, bash, name, workDir };
	}

	const alice = createAgent("Alice", "alice@agents.dev", "/alice");
	const bob = createAgent("Bob", "bob@agents.dev", "/bob");
	const coordinator = createAgent("Coordinator", "coord@agents.dev", "/coordinator");

	// Each agent clones from origin
	let ts = 1000000100;

	for (const agent of [alice, bob, coordinator]) {
		const env = agentEnv(agent.name, `${agent.name.toLowerCase()}@agents.dev`, ts++);
		const result = await agent.bash.exec(`git clone /origin ${agent.workDir}`, {
			cwd: "/",
			env,
		});
		console.log(`${agent.name} cloned: ${result.stderr.trim()}`);
	}
	console.log();

	// ── Step 3: Agents work independently ─────────────────────────

	// Alice: adds a new feature module
	const aliceTs = ts++;
	const aliceEnv = agentEnv("Alice", "alice@agents.dev", aliceTs);

	await alice.bash.exec("git checkout -b feature/auth", { env: aliceEnv });
	await alice.bash.writeFile(
		`${alice.workDir}/src/auth.ts`,
		[
			'import { VERSION } from "./index.ts";',
			"",
			"export interface User {",
			"  id: string;",
			"  name: string;",
			"  email: string;",
			"}",
			"",
			"export function authenticate(token: string): User | null {",
			'  if (token === "valid") {',
			'    return { id: "1", name: "Agent", email: "agent@example.com" };',
			"  }",
			"  return null;",
			"}",
			"",
		].join("\n"),
	);
	await alice.bash.exec("git add .", { env: aliceEnv });
	await alice.bash.exec('git commit -m "feat: add authentication module"', { env: aliceEnv });
	const alicePush = await alice.bash.exec("git push origin feature/auth", { env: aliceEnv });
	console.log(`Alice pushed feature/auth: exit=${alicePush.exitCode}`);

	// Bob: adds a utility module
	const bobTs = ts++;
	const bobEnv = agentEnv("Bob", "bob@agents.dev", bobTs);

	await bob.bash.exec("git checkout -b feature/utils", { env: bobEnv });
	await bob.bash.writeFile(
		`${bob.workDir}/src/utils.ts`,
		[
			"export function slugify(text: string): string {",
			"  return text.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '');",
			"}",
			"",
			"export function truncate(text: string, maxLen: number): string {",
			"  if (text.length <= maxLen) return text;",
			'  return text.slice(0, maxLen - 3) + "...";',
			"}",
			"",
		].join("\n"),
	);
	await bob.bash.exec("git add .", { env: bobEnv });
	await bob.bash.exec('git commit -m "feat: add string utility functions"', { env: bobEnv });
	const bobPush = await bob.bash.exec("git push origin feature/utils", { env: bobEnv });
	console.log(`Bob pushed feature/utils: exit=${bobPush.exitCode}`);
	console.log();

	// ── Step 4: Coordinator merges everything ─────────────────────

	const coordTs1 = ts++;
	const coordEnv1 = agentEnv("Coordinator", "coord@agents.dev", coordTs1);

	// Fetch latest from origin
	const fetchResult = await coordinator.bash.exec("git fetch origin", { env: coordEnv1 });
	console.log(`Coordinator fetched: exit=${fetchResult.exitCode}`);

	// Check what branches are available
	const branches = await coordinator.bash.exec("git branch -a", { env: coordEnv1 });
	console.log("Available branches:");
	console.log(branches.stdout);

	// Merge Alice's feature
	await coordinator.bash.exec("git merge origin/feature/auth --no-ff -m 'Merge feature/auth'", {
		env: agentEnv("Coordinator", "coord@agents.dev", ts++),
	});
	console.log("Merged feature/auth into main");

	// Merge Bob's feature
	await coordinator.bash.exec("git merge origin/feature/utils --no-ff -m 'Merge feature/utils'", {
		env: agentEnv("Coordinator", "coord@agents.dev", ts++),
	});
	console.log("Merged feature/utils into main");

	// Push the integrated main back to origin
	const pushMain = await coordinator.bash.exec("git push origin main", {
		env: agentEnv("Coordinator", "coord@agents.dev", ts++),
	});
	console.log(`Coordinator pushed main: exit=${pushMain.exitCode}`);
	console.log();

	// ── Step 5: View the integrated history ───────────────────────
	const log = await coordinator.bash.exec("git log --oneline", {
		env: agentEnv("Coordinator", "coord@agents.dev", ts),
	});
	console.log("=== Integrated history ===");
	console.log(log.stdout);

	// Verify all files are present
	const status = await coordinator.bash.exec("git status", {
		env: agentEnv("Coordinator", "coord@agents.dev", ts),
	});
	console.log("=== Working tree status ===");
	console.log(status.stdout);

	// Show the final file listing
	const lsFiles = await coordinator.bash.exec("git ls-files", {
		env: agentEnv("Coordinator", "coord@agents.dev", ts),
	});
	console.log("=== Files in repo ===");
	console.log(lsFiles.stdout);

	// ── Step 6: Agents can pull the integrated work ───────────────
	const alicePull = await alice.bash.exec("git checkout main && git pull origin main", {
		env: agentEnv("Alice", "alice@agents.dev", ts++),
	});
	console.log(`Alice pulled integrated main: exit=${alicePull.exitCode}`);

	const bobHasUtils = await bob.bash.exec(
		"git checkout main && git pull origin main && git log --oneline",
		{ env: agentEnv("Bob", "bob@agents.dev", ts++) },
	);
	console.log(`Bob pulled and sees:`);
	console.log(bobHasUtils.stdout);

	console.log("\n=== Multi-agent collaboration complete ===");
}

run().catch(console.error);
