/**
 * Smoke-tests every code example from the README to make sure they work.
 *
 * Run: bun examples/readme-examples.ts
 */

import { Bash } from "just-bash";
import { createGit } from "../src";

// ── Quick start ─────────────────────────────────────────────────────

{
	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
	});

	const bash = new Bash({
		cwd: "/repo",
		customCommands: [git],
	});

	await bash.exec("git init");
	await bash.exec("echo 'hello' > README.md");
	await bash.exec("git add .");
	await bash.exec('git commit -m "initial commit"');
	const log = await bash.exec("git log --oneline");
	console.log("Quick start:", log.stdout.trim());
}

// ── Options: disabled commands ──────────────────────────────────────

{
	const git = createGit({
		identity: { name: "Agent Bot", email: "bot@company.com", locked: true },
		disabled: ["push", "rebase", "remote", "clone", "fetch", "pull"],
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	const r = await bash.exec("git push origin main");
	console.assert(r.exitCode !== 0, "disabled command should fail");
	console.log("Disabled commands: blocked as expected");
}

// ── beforeCommand: audit log ────────────────────────────────────────

{
	const auditLog: { command: string; args: readonly string[]; exitCode: number }[] = [];

	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: {
			afterCommand: ({ command, args, result }) => {
				auditLog.push({
					command: `git ${command}`,
					args,
					exitCode: result.exitCode,
				});
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	await bash.exec("git status");

	console.assert(auditLog.length === 2, "should have 2 audit entries");
	console.assert(auditLog[0]?.command === "git init", "first should be init");
	console.assert(auditLog[1]?.command === "git status", "second should be status");
	console.log("Audit log:", auditLog.map((e) => e.command).join(", "));
}

// ── beforeCommand: gate pushes ──────────────────────────────────────

{
	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: {
			beforeCommand: ({ command }) => {
				if (command === "push") {
					return { reject: true, message: "Push blocked — awaiting approval.\n" };
				}
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	const r = await bash.exec("git push origin main");
	console.assert(r.exitCode === 1, "push should be blocked");
	console.assert(r.stderr.includes("awaiting approval"), "should have approval message");
	console.log("Gate push:", r.stderr.trim());
}

// ── beforeCommand: block large files (uses event.fs) ────────────────

{
	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: {
			beforeCommand: async ({ command, args, fs, cwd }) => {
				if (command === "add") {
					for (const path of args.filter((a) => !a.startsWith("-"))) {
						const resolved = path.startsWith("/") ? path : `${cwd}/${path}`;
						const stat = await fs.stat(resolved).catch(() => null);
						if (stat && stat.size > 5_000_000) {
							return { reject: true, message: `Blocked: ${path} exceeds 5 MB\n` };
						}
					}
				}
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");

	// Small file should pass
	await bash.exec("echo 'small' > ok.txt");
	const ok = await bash.exec("git add ok.txt");
	console.assert(ok.exitCode === 0, "small file should be allowed");

	// Large file should be blocked
	await bash.fs.writeFile("/repo/huge.bin", "x".repeat(6_000_000));
	const blocked = await bash.exec("git add huge.bin");
	console.assert(blocked.exitCode === 1, "large file should be blocked");
	console.assert(blocked.stderr.includes("exceeds 5 MB"), "should mention size limit");
	console.log("Large file block:", blocked.stderr.trim());
}

// ── Pre-hook: block secrets ─────────────────────────────────────────

{
	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: {
			preCommit: ({ index }) => {
				const forbidden = index.entries.filter((e) => /\.(env|pem|key)$/.test(e.path));
				if (forbidden.length) {
					return { reject: true, message: `Blocked: ${forbidden.map((e) => e.path).join(", ")}` };
				}
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	await bash.exec("echo 'SECRET=x' > .env");
	await bash.exec("git add .");
	const r = await bash.exec('git commit -m "oops"');
	console.assert(r.exitCode !== 0, "commit with .env should fail");
	console.assert(r.stderr.includes("Blocked"), "should mention blocked");
	console.log("Pre-commit secret block:", r.stderr.trim());
}

// ── Pre-hook: enforce conventional commits ──────────────────────────

{
	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: {
			commitMsg: (event) => {
				if (!/^(feat|fix|docs|refactor|test|chore)(\(.+\))?:/.test(event.message)) {
					return {
						reject: true,
						message: "Commit message must follow conventional commits format",
					};
				}
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	await bash.exec("echo 'hi' > file.txt");
	await bash.exec("git add .");

	const bad = await bash.exec('git commit -m "did stuff"');
	console.assert(bad.exitCode !== 0, "non-conventional message should fail");

	const good = await bash.exec('git commit -m "fix: correct the thing"');
	console.assert(good.exitCode === 0, "conventional message should pass");
	console.log("Conventional commits: bad rejected, good accepted");
}

// ── Post-hooks: observational ───────────────────────────────────────

{
	const commits: { hash: string; branch: string | null; message: string }[] = [];

	const git = createGit({
		identity: { name: "Alice", email: "alice@example.com" },
		hooks: {
			postCommit: (event) => {
				commits.push({ hash: event.hash, branch: event.branch, message: event.message });
			},
		},
	});

	const bash = new Bash({ cwd: "/repo", customCommands: [git] });
	await bash.exec("git init");
	await bash.exec("echo 'hi' > file.txt");
	await bash.exec("git add .");
	await bash.exec('git commit -m "first"');
	await bash.exec("echo 'more' >> file.txt");
	await bash.exec("git add .");
	await bash.exec('git commit -m "second"');

	console.assert(commits.length === 2, "should have 2 post-commit events");
	console.assert(commits[0]?.message.trim() === "first", "first commit message");
	console.assert(commits[1]?.message.trim() === "second", "second commit message");
	console.log(
		"Post-commit hooks:",
		commits.map((c) => `${c.hash.slice(0, 7)} "${c.message.trim()}"`).join(", "),
	);
}

console.log("\nAll README examples verified.");
