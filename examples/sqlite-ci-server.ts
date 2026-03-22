/**
 * SQLite-backed Git server with CI script runner.
 *
 * Serves repos over Smart HTTP with SQLite storage. On every push,
 * reads .ci/test.sh from the pushed commit, clones the repo into
 * an isolated in-memory sandbox (Bash + Git), and runs the script.
 * If the script fails, the push is rejected.
 *
 * Run:   bun examples/sqlite-ci-server.ts
 * Clone: git clone http://localhost:4200/my-repo
 * Push:  (commit a .ci/test.sh, then push — it runs in the sandbox)
 */

import { Database } from "bun:sqlite";
import { Bash } from "just-bash";
import { createGit, type GitRepo } from "../src";
import { createGitServer, BunSqliteStorage } from "../src/server";
import { readFileAtCommit, createSandboxWorktree } from "../src/repo";

const DB_PATH = process.env.DB_PATH ?? ":memory:";
const PORT = Number(process.env.PORT ?? 4200);

const CI_SCRIPT = ".ci/test.sh";
const CI_ENV = {
	GIT_AUTHOR_NAME: "CI Runner",
	GIT_AUTHOR_EMAIL: "ci@localhost",
	GIT_COMMITTER_NAME: "CI Runner",
	GIT_COMMITTER_EMAIL: "ci@localhost",
};

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
const storage = new BunSqliteStorage(db);

async function runCIScript(
	repo: GitRepo,
	commitHash: string,
): Promise<{
	passed: boolean;
	output: string;
}> {
	const script = await readFileAtCommit(repo, commitHash, CI_SCRIPT);
	if (!script) return { passed: true, output: `No ${CI_SCRIPT} found — skipping` };

	const { ctx } = await createSandboxWorktree(repo, {
		ref: commitHash,
		workTree: "/workspace",
	});

	const git = createGit({
		objectStore: ctx.objectStore,
		refStore: ctx.refStore,
		fs: ctx.fs,
		cwd: ctx.workTree!,
		gitDir: ctx.gitDir,
		identity: { name: "CI Runner", email: "ci@localhost" },
	});

	const sandbox = new Bash({
		fs: ctx.fs as any,
		cwd: "/workspace",
		customCommands: [git],
	});

	const result = await sandbox.exec(`bash ${CI_SCRIPT}`, {
		cwd: "/workspace",
		env: CI_ENV,
	});

	return {
		passed: result.exitCode === 0,
		output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
	};
}

const server = createGitServer({
	resolveRepo: (repoPath) => {
		console.log(`  [resolve] ${repoPath}`);
		return storage.repo(repoPath) ?? storage.createRepo(repoPath);
	},

	hooks: {
		preReceive: async ({ repo, updates, repoPath }) => {
			for (const update of updates) {
				if (update.isDelete) continue;

				console.log(
					`  [CI] ${repoPath} — running ${CI_SCRIPT} for ${update.ref} @ ${update.newHash.slice(0, 7)}`,
				);
				const { passed, output } = await runCIScript(repo, update.newHash);

				for (const line of output.split("\n")) {
					console.log(`  [CI] ${passed ? " " : "!"} ${line}`);
				}

				if (!passed) {
					console.log(`  [CI] REJECTED push to ${update.ref}`);
					return { reject: true, message: `CI failed:\n${output}` };
				}
				console.log(`  [CI] PASSED`);
			}
		},

		postReceive: async ({ updates, repoPath }) => {
			for (const u of updates) {
				console.log(
					`  [push] ${repoPath} ${u.ref}: ${(u.oldHash ?? "0000000").slice(0, 7)}..${u.newHash.slice(0, 7)}`,
				);
			}
		},
	},
});

const srv = Bun.serve({ fetch: server.fetch, port: PORT });

console.log(`just-git CI server listening on http://localhost:${srv.port}`);
console.log(`database: ${DB_PATH === ":memory:" ? "(in-memory)" : DB_PATH}`);
console.log(`CI script: ${CI_SCRIPT}`);
console.log();
console.log("usage:");
console.log(`  git clone http://localhost:${srv.port}/<repo-name>`);
console.log();
console.log("  # Add a CI script and push:");
console.log("  mkdir -p .ci");
console.log("  cat > .ci/test.sh << 'EOF'");
console.log("  #!/bin/bash");
console.log("  set -e");
console.log('  echo "Running tests..."');
console.log("  git log --oneline -3");
console.log('  echo "All checks passed"');
console.log("  EOF");
console.log('  git add . && git commit -m "add CI" && git push');
