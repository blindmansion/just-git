/**
 * Dual-protocol Git server: serves repos over both HTTP and SSH.
 *
 * One `createGitServer` call creates a unified handler with both
 * `fetch` (for HTTP) and `handleSession` (for SSH). The ssh2
 * dependency stays in userland — just-git remains zero-dependency.
 *
 * Run:   bun examples/ssh-http-server.ts
 * Clone: git clone http://localhost:4200/<repo>
 *        git clone ssh://git@localhost:2222/<repo>
 * Push:  (just push normally after cloning)
 *
 * Prerequisites:
 *   bun add ssh2 @types/ssh2
 *   Generate a host key: ssh-keygen -t ed25519 -f host_key -N ""
 */

import { readFileSync } from "node:fs";
import { Server } from "ssh2";
import { Database } from "bun:sqlite";
import {
	createGitServer,
	BunSqliteDriver,
	type SshChannel,
	type PostReceiveEvent,
} from "../src/server"; // "just-git/server"

// ── Config ──────────────────────────────────────────────────────────

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 4200);
const SSH_PORT = Number(process.env.SSH_PORT ?? 2222);
const DB_PATH = process.env.DB_PATH ?? ":memory:";
const HOST_KEY_PATH = process.env.HOST_KEY ?? "host_key";

// ── Single unified server ───────────────────────────────────────────

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");

const server = createGitServer({
	storage: new BunSqliteDriver(db),
	autoCreate: true,
	policy: {
		protectedBranches: ["main", "master"],
		denyNonFastForward: true,
		denyDeleteTags: true,
	},
	hooks: {
		preReceive: async ({ updates }) => {
			console.log(`  [pre-receive] ${updates.length} ref update(s)`);
		},
		postReceive: async ({ updates }: PostReceiveEvent) => {
			for (const u of updates) {
				const old = (u.oldHash ?? "0000000").slice(0, 7);
				const neu = u.newHash.slice(0, 7);
				console.log(`  [push] ${u.ref}: ${old}..${neu}`);
			}
		},
	},
});

// ── HTTP ────────────────────────────────────────────────────────────

const http = Bun.serve({ port: HTTP_PORT, fetch: server.fetch });

// ── SSH (ssh2 adapter) ──────────────────────────────────────────────

const hostKey = readFileSync(HOST_KEY_PATH);

const ssh = new Server({ hostKeys: [hostKey] }, (client) => {
	let username: string | undefined;

	client.on("authentication", (ctx) => {
		username = ctx.username;
		ctx.accept();
	});

	client.on("session", (accept) => {
		accept().on("exec", (accept, _reject, info) => {
			const stream = accept();

			const channel: SshChannel = {
				readable: new ReadableStream({
					start(controller) {
						stream.on("data", (d: Buffer) => controller.enqueue(new Uint8Array(d)));
						stream.on("end", () => controller.close());
					},
				}),
				writable: new WritableStream({
					write(chunk) {
						stream.write(chunk);
					},
				}),
				writeStderr(data) {
					stream.stderr.write(data);
				},
			};

			server.handleSession(info.command, channel, { username }).then((code) => {
				stream.exit(code);
				stream.close();
			});
		});
	});
});

ssh.listen(SSH_PORT);

// ── Ready ───────────────────────────────────────────────────────────

console.log(`
just-git dual-protocol server

  HTTP: http://localhost:${http.port}
  SSH:  ssh://git@localhost:${SSH_PORT}
  DB:   ${DB_PATH === ":memory:" ? "(in-memory)" : DB_PATH}

  Policies:
    - main/master branches protected (no force-push, no delete)
    - non-fast-forward pushes denied globally
    - tags are immutable (no delete, no overwrite)

  Usage:
    git clone http://localhost:${http.port}/<repo>
    git clone ssh://git@localhost:${SSH_PORT}/<repo>
    git push
`);
