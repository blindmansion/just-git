/**
 * Most common usage: clone a remote repo into the virtual filesystem,
 * configure credentials and identity, let an AI agent work on it,
 * then push changes back.
 *
 * Run: GITHUB_TOKEN=ghp_... bun examples/agent-remote-workflow.ts
 */

import { Bash } from "just-bash";
import { createGit } from "../src";

const REPO_URL = "https://github.com/some-org/some-repo.git";
const TOKEN = process.env.GITHUB_TOKEN ?? "ghp_your_token_here";

// ── 1. Configure git with identity + credentials ────────────────────

const git = createGit({
	identity: { name: "AI Agent", email: "agent@example.com", locked: true },
	credentials: async () => ({
		type: "bearer",
		token: TOKEN,
	}),
	network: {
		allowed: ["github.com"],
	},
});

// ── 2. Create the virtual shell ─────────────────────────────────────

const bash = new Bash({
	cwd: "/repo",
	customCommands: [git],
});

// ── 3. Clone the remote repo ────────────────────────────────────────

const clone = await bash.exec(`git clone ${REPO_URL} .`);
if (clone.exitCode !== 0) {
	console.error("Clone failed:", clone.stderr);
	process.exit(1);
}

// ── 4. Agent does its work ──────────────────────────────────────────

await bash.exec("git checkout -b agent/fix-typo");
await bash.exec(`echo 'fixed content' > README.md`);
await bash.exec("git add .");
await bash.exec('git commit -m "fix: correct typo in README"');

// ── 5. Push changes back ────────────────────────────────────────────

const push = await bash.exec("git push -u origin agent/fix-typo");
if (push.exitCode !== 0) {
	console.error("Push failed:", push.stderr);
	process.exit(1);
}

console.log("Done — branch pushed to remote.");
