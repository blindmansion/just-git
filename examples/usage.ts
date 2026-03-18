/**
 * Runnable example showing how a sandbox operator wires up
 * just-git with hooks, credentials, and identity.
 *
 * Run: bun examples/usage.ts
 */

import { Bash, type BashExecResult } from "just-bash";
import { createGit, composeGitHooks } from "../src";

const ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

function print(label: string, r: BashExecResult) {
	const out = [r.stdout, r.stderr].filter(Boolean).join("").trimEnd();
	console.log(
		`  ${label} → exit ${r.exitCode}${out ? `\n    ${out.replace(/\n/g, "\n    ")}` : ""}`,
	);
}

// ─── 1. Basic setup ─────────────────────────────────────────────────────────
console.log("\n═══ 1. Basic setup ═══");

const git = createGit();
const bash = new Bash({
	cwd: "/repo",
	env: ENV,
	customCommands: [git],
});

print("init", await bash.exec("git init"));
await bash.exec("echo 'hello' > README.md");
print("add", await bash.exec("git add ."));
print("commit", await bash.exec('git commit -m "initial commit"'));
print("log", await bash.exec("git log --oneline"));

// ─── 2. Disabled commands ────────────────────────────────────────────────────
console.log("\n═══ 2. Disabled commands ═══");

const gitRestricted = createGit({
	disabled: ["push", "rebase", "remote", "clone", "fetch", "pull"],
});

const restrictedBash = new Bash({
	cwd: "/restricted",
	env: ENV,
	customCommands: [gitRestricted],
});

print("init", await restrictedBash.exec("git init"));
print("push (blocked)", await restrictedBash.exec("git push origin main"));
print("rebase (blocked)", await restrictedBash.exec("git rebase main"));
await restrictedBash.exec("echo 'x' > file.txt");
print("add (allowed)", await restrictedBash.exec("git add ."));
print("commit (allowed)", await restrictedBash.exec('git commit -m "works fine"'));

// ─── 3. Locked identity ────────────────────────────────────────────────────
console.log("\n═══ 3. Locked identity ═══");

const gitLocked = createGit({
	identity: { name: "Agent Bot", email: "bot@company.com", locked: true },
});

const lockedBash = new Bash({
	cwd: "/locked",
	env: ENV,
	customCommands: [gitLocked],
});

await lockedBash.exec("git init");
await lockedBash.exec("echo 'data' > file.txt && git add .");
await lockedBash.exec('git commit -m "locked identity commit"');
// Even though ENV sets GIT_AUTHOR_NAME=Test, the locked identity wins:
const logResult = await lockedBash.exec("git log --oneline -1");
const showResult = await lockedBash.exec("git show HEAD");
const authorLine = showResult.stdout.split("\n").find((l: string) => l.startsWith("Author:"));
print("log", logResult);
console.log(`  Author line: ${authorLine?.trim()}`);

// ─── 4. Fallback identity ──────────────────────────────────────────────────
console.log("\n═══ 4. Fallback identity ═══");

const gitFallback = createGit({
	identity: { name: "Default User", email: "default@example.com" },
});

// With env vars set → env vars win (fallback not used)
const fallbackBash1 = new Bash({
	cwd: "/fallback1",
	env: ENV,
	customCommands: [gitFallback],
});
await fallbackBash1.exec("git init && echo 'a' > f.txt && git add . && git commit -m 'with env'");
const fb1Author = (await fallbackBash1.exec("git show HEAD")).stdout
	.split("\n")
	.find((l: string) => l.startsWith("Author:"));
console.log(`  With env vars:    ${fb1Author?.trim()}`);

// Without env vars → fallback identity used
const fallbackBash2 = new Bash({
	cwd: "/fallback2",
	customCommands: [gitFallback],
});
await fallbackBash2.exec(
	"git init && echo 'b' > f.txt && git add . && git commit -m 'with fallback'",
);
const fb2Author = (await fallbackBash2.exec("git show HEAD")).stdout
	.split("\n")
	.find((l: string) => l.startsWith("Author:"));
console.log(`  Without env vars: ${fb2Author?.trim()}`);

// ─── 5. Operation hooks ────────────────────────────────────────────────────
console.log("\n═══ 5. Operation hooks ═══");

{
	const g = createGit({
		hooks: {
			preCommit: ({ index }) => {
				const forbidden = index.entries.some((e) => e.path.includes(".env"));
				if (forbidden) {
					return { reject: true, message: "Cannot commit .env files" };
				}
			},

			commitMsg: (event) => {
				if (!event.message.match(/^(feat|fix|docs|chore|refactor):/)) {
					return {
						reject: true,
						message: "Message must start with feat:/fix:/docs:/chore:/refactor:",
					};
				}
			},

			postCommit: (event) => {
				console.log(
					`  [post-commit] ${event.hash.slice(0, 7)} on ${event.branch}: "${event.message.trim()}"`,
				);
			},
		},
	});

	const b = new Bash({
		cwd: "/hooks",
		env: ENV,
		customCommands: [g],
	});
	await b.exec("git init");

	// Normal commit with conventional message → succeeds
	await b.exec("echo 'x' > app.ts && git add .");
	print("feat commit", await b.exec('git commit -m "feat: add app"'));

	// Bad message → rejected by commitMsg hook
	await b.exec("echo 'y' > lib.ts && git add .");
	print("bad message", await b.exec('git commit -m "added lib"'));

	// .env file → rejected by preCommit hook
	await b.exec("echo 'SECRET=x' > .env && git add .");
	print(".env blocked", await b.exec('git commit -m "feat: add config"'));
}

// ─── 6. Commit message mutation ─────────────────────────────────────────────
console.log("\n═══ 6. Commit message mutation ═══");

{
	const g = createGit({
		hooks: {
			commitMsg: (event) => {
				event.message = `[auto-prefix] ${event.message}`;
			},
		},
	});

	const b = new Bash({
		cwd: "/mutate",
		env: ENV,
		customCommands: [g],
	});
	await b.exec("git init && echo 'x' > f.txt && git add .");
	await b.exec('git commit -m "original message"');
	const log2 = await b.exec("git log --oneline -1");
	print("mutated log", log2);
}

// ─── 7. Low-level events ───────────────────────────────────────────────────
console.log("\n═══ 7. Low-level events ═══");

{
	const refs: string[] = [];
	const objects: string[] = [];

	const g = createGit({
		hooks: {
			onRefUpdate: (event) => {
				refs.push(
					`${event.ref}: ${event.oldHash?.slice(0, 7) ?? "(new)"} → ${event.newHash.slice(0, 7)}`,
				);
			},
			onObjectWrite: (event) => {
				objects.push(`${event.type}:${event.hash.slice(0, 7)}`);
			},
		},
	});

	const b = new Bash({
		cwd: "/events",
		env: ENV,
		customCommands: [g],
	});
	await b.exec("git init && echo 'hello' > f.txt && git add . && git commit -m 'first'");

	console.log(`  Objects written: ${objects.join(", ")}`);
	console.log(`  Ref updates: ${refs.join(", ")}`);
}

// ─── 8. beforeCommand / afterCommand hooks ──────────────────────────────────
console.log("\n═══ 8. Command-level hooks ═══");

{
	const log3: string[] = [];

	const g = createGit({
		hooks: {
			beforeCommand: ({ command }) => {
				console.log(`  [before] git ${command} starting`);
			},
			afterCommand: ({ command, result }) => {
				log3.push(`git ${command} → exit ${result.exitCode}`);
			},
		},
	});

	const b = new Bash({ cwd: "/mw", env: ENV, customCommands: [g] });
	await b.exec("git init");
	await b.exec("echo 'x' > f.txt && git add . && git commit -m 'test'");
	console.log(`  Telemetry: ${log3.join(", ")}`);
}

// ─── 9. composeGitHooks ─────────────────────────────────────────────────────
console.log("\n═══ 9. composeGitHooks ═══");

{
	const auditEntries: string[] = [];
	const policyRejections: string[] = [];

	const auditHooks = {
		postCommit: ({ hash, message }: { hash: string; message: string }) => {
			auditEntries.push(`${hash.slice(0, 7)}: ${message.trim()}`);
		},
	};

	const policyHooks = {
		preCommit: ({ index }: { index: { entries: { path: string }[] } }) => {
			if (index.entries.some((e) => e.path.endsWith(".env"))) {
				policyRejections.push(".env blocked");
				return { reject: true as const, message: "No .env files allowed" };
			}
		},
	};

	const g = createGit({
		hooks: composeGitHooks(auditHooks, policyHooks),
	});

	const b = new Bash({ cwd: "/compose", env: ENV, customCommands: [g] });
	await b.exec("git init");
	await b.exec("echo 'x' > app.ts && git add . && git commit -m 'good commit'");
	await b.exec("echo 'SECRET' > .env && git add . && git commit -m 'bad commit'");

	console.log(`  Audit entries: ${auditEntries.join(", ")}`);
	console.log(`  Policy rejections: ${policyRejections.join(", ")}`);
}

// ─── 10. Combined: full sandbox setup ───────────────────────────────────────
console.log("\n═══ 10. Full sandbox ═══");

{
	const auditLog: string[] = [];
	const telemetry: string[] = [];

	const g = createGit({
		identity: { name: "Agent", email: "agent@sandbox.dev", locked: true },
		disabled: ["rebase", "remote", "push", "fetch", "pull", "clone"],
		hooks: {
			preCommit: ({ index }) => {
				const hasSecrets = index.entries.some(
					(e) => e.path.endsWith(".env") || e.path.includes("credentials"),
				);
				if (hasSecrets) {
					return { reject: true, message: "Blocked: secret files cannot be committed" };
				}
			},
			postCommit: (event) => {
				auditLog.push(
					`${event.hash.slice(0, 7)} by ${event.author.name} <${event.author.email}>: ${event.message}`,
				);
			},
			afterCommand: ({ command, result }) => {
				telemetry.push(`git ${command} → exit ${result.exitCode}`);
			},
		},
	});

	const b = new Bash({
		cwd: "/sandbox",
		env: ENV,
		customCommands: [g],
	});

	await b.exec("git init");
	await b.exec("echo 'code' > app.ts && git add . && git commit -m 'build app'");
	await b.exec("echo 'SECRET' > .env && git add . && git commit -m 'add config'");
	await b.exec("git rebase main");
	await b.exec("git log --oneline");

	console.log("  Audit log:");
	for (const entry of auditLog) console.log(`    ${entry}`);
	console.log("  Telemetry:");
	for (const entry of telemetry) console.log(`    ${entry}`);
}

console.log("\n✓ All examples ran successfully.\n");
