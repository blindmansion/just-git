/**
 * Git-over-SSH session handler.
 *
 * Transport-agnostic: accepts web-standard streams for I/O, works with
 * any SSH library (ssh2, etc.) through a thin adapter layer. The core
 * package remains zero-dependency — SSH library wiring lives outside.
 *
 * ```ts
 * import { Server } from "ssh2";
 * import { createGitSshServer } from "just-git/server";
 *
 * const handler = createGitSshServer({
 *   resolveRepo: (path) => storage.repo(path),
 * });
 *
 * new Server({ hostKeys: [key] }, (client) => {
 *   let username: string | undefined;
 *   client.on("authentication", (ctx) => { username = ctx.username; ctx.accept(); });
 *   client.on("session", (accept) => {
 *     accept().on("exec", (accept, reject, info) => {
 *       const stream = accept();
 *       const channel: SshChannel = {
 *         readable: new ReadableStream({
 *           start(c) {
 *             stream.on("data", (d: Buffer) => c.enqueue(new Uint8Array(d)));
 *             stream.on("end", () => c.close());
 *           },
 *         }),
 *         writable: new WritableStream({ write(chunk) { stream.write(chunk); } }),
 *         writeStderr(data) { stream.stderr.write(data); },
 *       };
 *       handler.handleSession(info.command, channel, { username })
 *         .then((code) => { stream.exit(code); stream.close(); });
 *     });
 *   });
 * });
 * ```
 */

import type { GitRepo } from "../lib/types.ts";
import {
	PackCache,
	buildRefListBytes,
	collectRefs,
	handleUploadPack,
	ingestReceivePackFromStream,
	applyReceivePack,
} from "./operations.ts";
import { buildReportStatus, type PushCommand } from "./protocol.ts";
import type { RefAdvertisement, ServerHooks } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface GitSshServerConfig {
	/**
	 * Resolve an SSH exec path to a repository.
	 *
	 * Return `GitRepo` to serve, or `null` to reject with
	 * "repository not found".
	 */
	resolveRepo: (
		repoPath: string,
		session: SshSessionInfo,
	) => GitRepo | null | Promise<GitRepo | null>;

	/** Server-side hooks. All optional. */
	hooks?: ServerHooks;

	/**
	 * Cache generated packfiles for identical full-clone requests.
	 * Set to `false` to disable. Default: enabled with 256 MB limit.
	 */
	packCache?: false | { maxBytes?: number };

	/** Control delta compression and streaming for upload-pack responses. */
	packOptions?: {
		noDelta?: boolean;
		deltaWindow?: number;
	};

	/**
	 * Called on unhandled errors during session handling.
	 * Set to `false` to suppress. Defaults to console.error.
	 */
	onError?: false | ((err: unknown) => void);
}

/** Information about the SSH session, available to resolveRepo and hooks. */
export interface SshSessionInfo {
	/** SSH username from authentication. */
	username?: string;
}

/**
 * Bidirectional channel for SSH session I/O.
 *
 * Adapters create this from their SSH library's channel/stream.
 * The handler reads the client request from `readable` and writes
 * the server response to `writable`.
 *
 * For receive-pack (push), `readable` must close when the client
 * finishes sending. For upload-pack (fetch/clone), the handler
 * reads protocol-aware pkt-lines and does not require EOF.
 */
export interface SshChannel {
	/** Client data (from client stdout via SSH channel). */
	readonly readable: ReadableStream<Uint8Array>;
	/** Server response (to client stdin via SSH channel). */
	readonly writable: WritableStream<Uint8Array>;
	/** Write a diagnostic/error message to the client's stderr. */
	writeStderr?(data: Uint8Array): void;
}

export interface GitSshServer {
	/**
	 * Handle a single git-over-SSH session.
	 *
	 * Call this when the SSH client execs a git command (typically
	 * `git-upload-pack` or `git-receive-pack`). Returns the exit code
	 * to send to the client.
	 *
	 * After this resolves, the caller should send the exit code via
	 * the SSH channel and close it.
	 */
	handleSession(command: string, channel: SshChannel, session?: SshSessionInfo): Promise<number>;
}

// ── Factory ─────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/**
 * Create a handler for git-over-SSH sessions.
 *
 * This is the SSH counterpart to `createGitServer` (HTTP). It handles
 * the git pack protocol over bidirectional streams, letting any SSH
 * library act as the transport layer.
 */
export function createGitSshServer(config: GitSshServerConfig): GitSshServer {
	if (!config || typeof config.resolveRepo !== "function") {
		throw new TypeError(
			"createGitSshServer: config.resolveRepo must be a function. " +
				"Example: createGitSshServer({ resolveRepo: (path) => storage.repo(path) })",
		);
	}

	const { resolveRepo, hooks } = config;

	const packCache =
		config.packCache === false ? undefined : new PackCache(config.packCache?.maxBytes);

	const onError =
		config.onError === false
			? undefined
			: (config.onError ??
				((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`[ssh] Internal error: ${msg}`);
				}));

	return {
		async handleSession(
			command: string,
			channel: SshChannel,
			session: SshSessionInfo = {},
		): Promise<number> {
			const writer = channel.writable.getWriter();
			try {
				const parsed = parseGitSshCommand(command);
				if (!parsed) {
					sendStderr(channel, `fatal: unrecognized command '${command}'\n`);
					return 128;
				}

				const { service, repoPath } = parsed;
				const repo = await resolveRepo(repoPath, session);
				if (!repo) {
					sendStderr(channel, `fatal: '${repoPath}' does not appear to be a git repository\n`);
					return 128;
				}

				const { refs: allRefs, headTarget } = await collectRefs(repo);
				let refs: RefAdvertisement[] = allRefs;
				if (hooks?.advertiseRefs) {
					const filtered = await hooks.advertiseRefs({
						repo,
						repoPath,
						refs: allRefs,
						service,
					});
					if (filtered) refs = filtered;
				}

				await writer.write(buildRefListBytes(refs, service, headTarget));

				const streamReader = new StreamPktLineReader(channel.readable);
				try {
					if (service === "git-upload-pack") {
						const requestBody = await readUploadPackRequest(streamReader);
						const result = await handleUploadPack(repo, requestBody, {
							cache: packCache,
							cacheKey: repoPath,
							noDelta: config.packOptions?.noDelta,
							deltaWindow: config.packOptions?.deltaWindow,
						});
						await writeResponse(writer, result);
					} else {
						const { commands, capabilities } =
							await readReceivePackCommands(streamReader);
						const packStream = streamReader.streamRemaining();
						await serveReceivePackStreaming(
							writer, repo, repoPath,
							commands, capabilities, packStream, hooks,
						);
					}
				} finally {
					streamReader.release();
				}

				return 0;
			} catch (err) {
				onError?.(err);
				sendStderr(channel, "fatal: internal error\n");
				return 128;
			} finally {
				try {
					await writer.close();
				} catch {
					// Channel may already be closed
				}
			}
		},
	};
}

// ── Receive-pack ────────────────────────────────────────────────────

async function serveReceivePackStreaming(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	repo: GitRepo,
	repoPath: string,
	commands: PushCommand[],
	capabilities: string[],
	packStream: AsyncIterable<Uint8Array>,
	hooks?: ServerHooks,
): Promise<void> {
	const ingestResult = await ingestReceivePackFromStream(
		repo, commands, capabilities, packStream,
	);
	if (ingestResult.updates.length === 0) return;

	const useSideband = ingestResult.capabilities.includes("side-band-64k");
	const useReportStatus = ingestResult.capabilities.includes("report-status");

	if (!ingestResult.unpackOk) {
		if (useReportStatus) {
			const refResults = ingestResult.updates.map((u) => ({
				name: u.ref,
				ok: false,
				error: "unpack failed",
			}));
			await writer.write(buildReportStatus(false, refResults, useSideband));
		}
		return;
	}

	const { refResults } = await applyReceivePack({
		repo,
		repoPath,
		ingestResult,
		hooks,
	});

	if (useReportStatus) {
		const reportResults = refResults.map((r) => ({
			name: r.ref,
			ok: r.ok,
			error: r.error,
		}));
		await writer.write(buildReportStatus(true, reportResults, useSideband));
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

type GitSshService = "git-upload-pack" | "git-receive-pack";

/**
 * Parse a git SSH exec command into service and repo path.
 *
 * Handles `git-upload-pack '/path'`, `git upload-pack '/path'`,
 * and unquoted variants.
 */
export function parseGitSshCommand(
	command: string,
): { service: GitSshService; repoPath: string } | null {
	const match = command.match(/^git[\s-](upload-pack|receive-pack)\s+'?([^']+?)'?\s*$/);
	if (!match) return null;

	const service = `git-${match[1]}` as GitSshService;
	let repoPath = match[2]!;
	if (repoPath.startsWith("/")) repoPath = repoPath.slice(1);

	return { service, repoPath };
}

function sendStderr(channel: SshChannel, message: string): void {
	channel.writeStderr?.(encoder.encode(message));
}

// ── Protocol-aware stream reading ───────────────────────────────────

const decoder = new TextDecoder();

/**
 * Buffered reader over a ReadableStream that supports exact-byte reads
 * and pkt-line parsing. Needed because SSH channels deliver data in
 * arbitrary chunks that don't align to pkt-line boundaries, and
 * upload-pack clients don't send EOF after their request.
 */
interface ByteReader {
	read(): Promise<{ value?: Uint8Array; done: boolean }>;
	releaseLock(): void;
}

class StreamPktLineReader {
	private buf = new Uint8Array(0);
	private byteReader: ByteReader;
	private eof = false;

	constructor(readable: ReadableStream<Uint8Array>) {
		this.byteReader = readable.getReader() as ByteReader;
	}

	private async fill(needed: number): Promise<boolean> {
		while (this.buf.byteLength < needed && !this.eof) {
			const result = await this.byteReader.read();
			if (result.done || !result.value) {
				this.eof = true;
				break;
			}
			const value = result.value;
			const merged = new Uint8Array(this.buf.byteLength + value.byteLength);
			merged.set(this.buf);
			merged.set(value, this.buf.byteLength);
			this.buf = merged;
		}
		return this.buf.byteLength >= needed;
	}

	private consume(n: number): Uint8Array {
		const result = this.buf.subarray(0, n);
		this.buf = this.buf.subarray(n);
		return result;
	}

	/** Read a single pkt-line. Returns null on EOF before a complete line. */
	async readPktLine(): Promise<
		{ type: "flush"; raw: Uint8Array } | { type: "data"; raw: Uint8Array; text: string } | null
	> {
		if (!(await this.fill(4))) return null;
		const lenHex = decoder.decode(this.buf.subarray(0, 4));
		const len = parseInt(lenHex, 16);
		if (len === 0) return { type: "flush", raw: this.consume(4) };
		if (len < 4) return null;
		if (!(await this.fill(len))) return null;
		const raw = new Uint8Array(this.consume(len));
		return { type: "data", raw, text: decoder.decode(raw.subarray(4)) };
	}

	/** Read all remaining bytes until EOF. Used for pack data after flush. */
	async readRemaining(): Promise<Uint8Array> {
		while (!this.eof) {
			const result = await this.byteReader.read();
			if (result.done || !result.value) {
				this.eof = true;
				break;
			}
			const value = result.value;
			const merged = new Uint8Array(this.buf.byteLength + value.byteLength);
			merged.set(this.buf);
			merged.set(value, this.buf.byteLength);
			this.buf = merged;
		}
		return this.consume(this.buf.byteLength);
	}

	/**
	 * Yield remaining bytes as an async iterable without buffering
	 * everything into memory. Flushes the internal buffer first,
	 * then forwards chunks from the underlying stream.
	 */
	async *streamRemaining(): AsyncGenerator<Uint8Array> {
		if (this.buf.byteLength > 0) {
			yield this.consume(this.buf.byteLength);
		}
		while (!this.eof) {
			const result = await this.byteReader.read();
			if (result.done || !result.value) {
				this.eof = true;
				break;
			}
			yield result.value;
		}
	}

	release(): void {
		this.byteReader.releaseLock();
	}
}

/**
 * Read an upload-pack request by parsing pkt-lines until "done".
 *
 * The git client keeps the SSH channel open during upload-pack — it
 * sends wants/haves/done and waits for the pack response without
 * sending EOF. We must stop reading at the protocol boundary.
 */
async function readUploadPackRequest(reader: StreamPktLineReader): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	while (true) {
		const line = await reader.readPktLine();
		if (!line) break;
		parts.push(line.raw);
		if (line.type === "data" && line.text.trimEnd() === "done") break;
	}
	return concatBytes(parts);
}

/**
 * Parse receive-pack pkt-line commands until flush.
 * After this returns, the reader's buffer holds the raw pack data
 * which can be streamed via `reader.streamRemaining()`.
 */
async function readReceivePackCommands(
	reader: StreamPktLineReader,
): Promise<{ commands: PushCommand[]; capabilities: string[] }> {
	const commands: PushCommand[] = [];
	let capabilities: string[] = [];
	let first = true;

	while (true) {
		const line = await reader.readPktLine();
		if (!line) break;
		if (line.type === "flush") break;

		let text = line.text;
		if (text.endsWith("\n")) text = text.slice(0, -1);

		if (first) {
			const nulIdx = text.indexOf("\0");
			if (nulIdx !== -1) {
				capabilities = text.slice(nulIdx + 1).split(" ").filter(Boolean);
				text = text.slice(0, nulIdx);
			}
			first = false;
		}

		const parts = text.split(" ");
		if (parts.length >= 3) {
			commands.push({
				oldHash: parts[0]!,
				newHash: parts[1]!,
				refName: parts.slice(2).join(" "),
			});
		}
	}

	return { commands, capabilities };
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
	if (arrays.length === 0) return new Uint8Array(0);
	if (arrays.length === 1) return arrays[0]!;
	let len = 0;
	for (const a of arrays) len += a.byteLength;
	const result = new Uint8Array(len);
	let off = 0;
	for (const a of arrays) {
		result.set(a, off);
		off += a.byteLength;
	}
	return result;
}

async function writeResponse(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	data: Uint8Array | ReadableStream<Uint8Array>,
): Promise<void> {
	if (data instanceof ReadableStream) {
		const reader = data.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				await writer.write(value);
			}
		} finally {
			reader.releaseLock();
		}
	} else {
		await writer.write(data);
	}
}
