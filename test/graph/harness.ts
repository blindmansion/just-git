import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createTestBash } from "../util";
import { RealGit } from "../real-git";
import type { GraphScenario } from "./types";

const COMMIT_COMMANDS = ["commit", "merge", "cherry-pick", "rebase --continue", "revert"];

function isCommitProducing(cmd: string): boolean {
	if (!cmd.startsWith("git ")) return false;
	const sub = cmd.slice(4);
	return COMMIT_COMMANDS.some((c) => sub.startsWith(c));
}

function makeEnv(n: number): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@test.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@test.com",
		GIT_AUTHOR_DATE: `${1000000000 + n}`,
		GIT_COMMITTER_DATE: `${1000000000 + n}`,
	};
}

// ── Virtual (just-git) ──────────────────────────────────────────────

export async function buildVirtual(
	scenario: GraphScenario,
): Promise<Map<string, { stdout: string; stderr: string; exitCode: number }>> {
	const files = scenario.files ?? { "/repo/README.md": "# Hello" };
	const bash = createTestBash({ files, env: makeEnv(0) });
	let ts = 0;

	for (const step of scenario.steps) {
		if (typeof step === "string") {
			const env = isCommitProducing(step) ? makeEnv(++ts) : undefined;
			await bash.exec(step, env ? { env } : undefined);
		} else if ("write" in step) {
			const path = step.write.startsWith("/") ? step.write : `/repo/${step.write}`;
			const dir = path.split("/").slice(0, -1).join("/");
			if (dir && dir !== "/repo") {
				await bash.fs.mkdir(dir, { recursive: true });
			}
			await bash.fs.writeFile(path, step.content);
		} else {
			const env = step.env ?? (isCommitProducing(step.cmd) ? makeEnv(++ts) : undefined);
			await bash.exec(step.cmd, env ? { env } : undefined);
		}
	}

	const logCommands = scenario.logCommands ?? ["git log --graph --all --oneline"];
	const results = new Map<string, { stdout: string; stderr: string; exitCode: number }>();

	for (const cmd of logCommands) {
		const r = await bash.exec(cmd);
		results.set(cmd, { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
	}

	return results;
}

// ── Real git ────────────────────────────────────────────────────────

export function buildReal(
	scenario: GraphScenario,
): Map<string, { stdout: string; stderr: string; exitCode: number }> {
	const git = RealGit.create({ env: { TZ: "UTC", ...makeEnv(0) }, prefix: "graph-cmp-" });
	const files = scenario.files ?? { "/repo/README.md": "# Hello" };

	for (const [vpath, content] of Object.entries(files)) {
		const rel = vpath.replace(/^\/repo\/?/, "");
		if (!rel) continue;
		const full = join(git.cwd, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}

	let ts = 0;

	const setup = [
		["init", "-b", "main"],
		["config", "user.name", "Test"],
		["config", "user.email", "test@test.com"],
	];
	for (const args of setup) {
		git.exec(args);
	}

	for (const step of scenario.steps) {
		if (typeof step === "string") {
			const env = isCommitProducing(step) ? makeEnv(++ts) : undefined;
			git.execShell(step, env);
		} else if ("write" in step) {
			const rel = step.write.startsWith("/") ? step.write.replace(/^\/repo\/?/, "") : step.write;
			const full = join(git.cwd, rel);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, step.content);
		} else {
			const env = step.env ?? (isCommitProducing(step.cmd) ? makeEnv(++ts) : undefined);
			git.execShell(step.cmd, env);
		}
	}

	const logCommands = scenario.logCommands ?? ["git log --graph --all --oneline"];
	const results = new Map<string, { stdout: string; stderr: string; exitCode: number }>();

	for (const cmd of logCommands) {
		const r = git.execShell(cmd);
		results.set(cmd, { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
	}

	git.cleanup();
	return results;
}

// ── Diff display ────────────────────────────────────────────────────

export function printComparison(vLines: string[], rLines: string[]) {
	const maxV = Math.max(...vLines.map((l) => l.length), 8);
	const colW = Math.min(maxV + 2, 50);

	console.log(`    ${"VIRTUAL".padEnd(colW)}  REAL GIT`);
	console.log(`    ${"─".repeat(colW)}  ${"─".repeat(colW)}`);

	const max = Math.max(vLines.length, rLines.length);
	for (let i = 0; i < max; i++) {
		const v = vLines[i] ?? "";
		const r = rLines[i] ?? "";
		const marker = v === r ? " " : "≠";
		console.log(`  ${marker} ${v.padEnd(colW)}  ${r}`);
	}
}
