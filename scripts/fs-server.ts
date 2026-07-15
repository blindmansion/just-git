#!/usr/bin/env bun
import * as nodeFs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getChangedFiles } from "../src/repo/index.ts";
import { createServer } from "../src/server/index.ts";
import { createNodeFsRepoPool } from "../src/store/index.ts";

const DEFAULT_PORT = 4201;
const projectRoot = join(dirname(import.meta.path), "..");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
	console.log(`Usage: bun scripts/fs-server.ts [options]

Start a just-git Smart HTTP server backed by native bare repositories.
Repositories are created on first push.

Options:
  --root <path>  Storage pool root (default: .fs-server)
  --port <n>     Listening port (default: ${DEFAULT_PORT}, or PORT)

Example:
  bun scripts/fs-server.ts --root /tmp/just-git-pool --port 4201
  git push http://localhost:4201/demo main`);
	process.exit(0);
}

const rootDir = resolve(readOption("--root") ?? join(projectRoot, ".fs-server"));
const port = Number(readOption("--port") ?? process.env.PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	throw new Error(`invalid port: ${JSON.stringify(port)}`);
}

await nodeFs.mkdir(rootDir, { recursive: true });
const pool = await createNodeFsRepoPool(nodeFs, rootDir);
const server = createServer({
	storage: pool,
	autoCreate: true,
	hooks: {
		advertiseRefs: ({ repoId, service, refs }) => {
			console.log(`[advertise] ${repoId} ${service}: ${refs.length} refs`);
		},
		preReceive: ({ repoId, updates }) => {
			console.log(`[pre-receive] ${repoId}: ${updates.length} updates`);
		},
		update: ({ repoId, update }) => {
			console.log(
				`[update] ${repoId} ${update.ref}: ${shortHash(update.oldHash)}..${shortHash(update.newHash)}`,
			);
		},
		postReceive: async ({ repo, repoId, updates }) => {
			for (const update of updates) {
				if (update.isDelete || !update.ref.startsWith("refs/heads/")) {
					console.log(
						`[push] ${repoId} ${update.ref}: ${shortHash(update.oldHash)}..${shortHash(update.newHash)}`,
					);
					continue;
				}
				const files = await getChangedFiles(repo, update.oldHash, update.newHash);
				console.log(
					`[push] ${repoId} ${update.ref}: ${shortHash(update.oldHash)}..${shortHash(update.newHash)} (${files.length} files changed)`,
				);
			}
		},
	},
});

const listener = Bun.serve({
	hostname: "127.0.0.1",
	port,
	fetch: server.fetch,
});

console.log(`just-git filesystem server listening on http://localhost:${listener.port}`);
console.log(`storage root: ${rootDir}`);
console.log(`push-to-create: git push http://localhost:${listener.port}/<repo-id> main`);

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	listener.stop();
	await server.close();
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

function readOption(name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

function shortHash(hash: string | null): string {
	return hash?.slice(0, 7) ?? "0000000";
}
