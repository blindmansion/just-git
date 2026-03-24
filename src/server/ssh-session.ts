/**
 * SSH protocol helpers for `createServer`'s `handleSession` method.
 *
 * Provides the pkt-line stream reader, command parser, and
 * receive-pack streaming logic. Internal to the server module —
 * users interact via `GitServer.handleSession`.
 */

import { isRejection } from "../hooks.ts";
import type { GitRepo } from "../lib/types.ts";
import {
	PackCache,
	advertiseRefsWithHooks,
	buildRefListBytes,
	buildV2CapabilityAdvertisementBytes,
	handleLsRefs,
	handleUploadPack,
	handleV2Fetch,
	ingestReceivePackFromStream,
	applyReceivePack,
} from "./operations.ts";
import { buildReportStatus, type PushCommand } from "./protocol.ts";
import type { ServerHooks, Auth, SshChannel } from "./types.ts";

// ── Command parser ──────────────────────────────────────────────────

type GitSshService = "git-upload-pack" | "git-receive-pack";

/**
 * Parse a git SSH exec command into service and repo path.
 *
 * Handles `git-upload-pack '/path'`, `git upload-pack '/path'`,
 * and unquoted variants. Sets `protocolV2` when the client
 * requests protocol version 2 via `--protocol=version=2`.
 */
export function parseGitSshCommand(
	command: string,
): { service: GitSshService; repoPath: string; protocolV2?: boolean } | null {
	const protocolV2 = /--protocol=version=2/.test(command);
	const cleaned = command.replace(/\s*--protocol=version=\d+/g, "");
	const match = cleaned.match(/^git[\s-](upload-pack|receive-pack)\s+'?([^']+?)'?\s*$/);
	if (!match) return null;

	const service = `git-${match[1]}` as GitSshService;
	let repoPath = match[2]!;
	if (repoPath.startsWith("/")) repoPath = repoPath.slice(1);

	return protocolV2 ? { service, repoPath, protocolV2 } : { service, repoPath };
}

// ── Session handler (used by createServer) ───────────────────────

const encoder = new TextEncoder();

interface HandleSessionOptions<A = Auth> {
	resolveRepo: (
		path: string,
	) => { repo: GitRepo; repoId: string } | null | Promise<{ repo: GitRepo; repoId: string } | null>;
	hooks?: ServerHooks<A>;
	packCache?: PackCache;
	packOptions?: { noDelta?: boolean; deltaWindow?: number };
	auth: A;
	onError?: (err: unknown) => void;
}

/**
 * Handle a single git-over-SSH session. Called by the unified server's
 * `handleSession` method — not meant to be used directly.
 */
export async function handleSshSession<A = Auth>(
	command: string,
	channel: SshChannel,
	options: HandleSessionOptions<A>,
): Promise<number> {
	const { resolveRepo, hooks, packCache, packOptions, auth } = options;
	const writer = channel.writable.getWriter();
	try {
		const parsed = parseGitSshCommand(command);
		if (!parsed) {
			sendStderr(channel, `fatal: unrecognized command '${command}'\n`);
			return 128;
		}

		const { service, repoPath: requestPath } = parsed;
		const resolved = await resolveRepo(requestPath);
		if (!resolved) {
			sendStderr(channel, `fatal: '${requestPath}' does not appear to be a git repository\n`);
			return 128;
		}
		const { repo, repoId } = resolved;

		// Protocol v2 over SSH: send capability advertisement, then command loop
		if (parsed.protocolV2 && service === "git-upload-pack") {
			const adv = await advertiseRefsWithHooks(repo, repoId, service, hooks, auth);
			if (isRejection(adv)) {
				sendStderr(channel, `fatal: ${adv.message ?? "access denied"}\n`);
				return 128;
			}

			await writer.write(buildV2CapabilityAdvertisementBytes());

			const streamReader = new StreamPktLineReader(channel.readable);
			try {
				await handleV2SshCommandLoop(streamReader, writer, repo, repoId, {
					hooks,
					packCache,
					packOptions,
					auth,
				});
			} finally {
				streamReader.release();
			}
			return 0;
		}

		// V2 not applicable for receive-pack — fall through to v1
		const adv = await advertiseRefsWithHooks(repo, repoId, service, hooks, auth);
		if (isRejection(adv)) {
			sendStderr(channel, `fatal: ${adv.message ?? "access denied"}\n`);
			return 128;
		}

		await writer.write(buildRefListBytes(adv.refs, service, adv.headTarget));

		const streamReader = new StreamPktLineReader(channel.readable);
		try {
			if (service === "git-upload-pack") {
				const requestBody = await readUploadPackRequest(streamReader);
				const result = await handleUploadPack(repo, requestBody, {
					cache: packCache,
					cacheKey: repoId,
					noDelta: packOptions?.noDelta,
					deltaWindow: packOptions?.deltaWindow,
				});
				await writeResponse(writer, result);
			} else {
				const { commands, capabilities } = await readReceivePackCommands(streamReader);
				const packStream = streamReader.streamRemaining();
				await serveReceivePackStreaming({
					writer,
					repo,
					repoId,
					commands,
					capabilities,
					packStream,
					hooks,
					auth,
				});
			}
		} finally {
			streamReader.release();
		}

		return 0;
	} catch (err) {
		options.onError?.(err);
		sendStderr(channel, "fatal: internal error\n");
		return 128;
	} finally {
		try {
			await writer.close();
		} catch {
			// Channel may already be closed
		}
	}
}

// ── Receive-pack ────────────────────────────────────────────────────

interface ServeReceivePackOptions<A> {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	repo: GitRepo;
	repoId: string;
	commands: PushCommand[];
	capabilities: string[];
	packStream: AsyncIterable<Uint8Array>;
	hooks?: ServerHooks<A>;
	auth: A;
}

async function serveReceivePackStreaming<A>(options: ServeReceivePackOptions<A>): Promise<void> {
	const { writer, repo, repoId, commands, capabilities, packStream, hooks, auth } = options;
	const ingestResult = await ingestReceivePackFromStream(repo, commands, capabilities, packStream);
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
		repoId,
		ingestResult,
		hooks,
		auth,
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
		| { type: "flush"; raw: Uint8Array }
		| { type: "delim"; raw: Uint8Array }
		| { type: "response-end"; raw: Uint8Array }
		| { type: "data"; raw: Uint8Array; text: string }
		| null
	> {
		if (!(await this.fill(4))) return null;
		const lenHex = decoder.decode(this.buf.subarray(0, 4));
		const len = parseInt(lenHex, 16);
		if (len === 0) return { type: "flush", raw: this.consume(4) };
		if (len === 1) return { type: "delim", raw: this.consume(4) };
		if (len === 2) return { type: "response-end", raw: this.consume(4) };
		if (len < 4) return null;
		if (!(await this.fill(len))) return null;
		const raw = new Uint8Array(this.consume(len));
		return { type: "data", raw, text: decoder.decode(raw.subarray(4)) };
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
		if (line.type !== "data") continue;

		let text = line.text;
		if (text.endsWith("\n")) text = text.slice(0, -1);

		if (first) {
			const nulIdx = text.indexOf("\0");
			if (nulIdx !== -1) {
				capabilities = text
					.slice(nulIdx + 1)
					.split(" ")
					.filter(Boolean);
				text = text.slice(0, nulIdx);
			}
			first = false;
		}

		const parts = text.split(" ");
		if (parts.length >= 3) {
			commands.push({
				oldHash: parts[0]!,
				newHash: parts[1]!,
				refName: parts[2]!,
			});
		}
	}

	return { commands, capabilities };
}

// ── V2 SSH command loop ─────────────────────────────────────────────

interface V2SshCommandLoopOptions<A> {
	hooks?: ServerHooks<A>;
	packCache?: PackCache;
	packOptions?: { noDelta?: boolean; deltaWindow?: number };
	auth: A;
}

/**
 * Read v2 command requests from the SSH channel and dispatch them.
 * Continues until the client sends a flush-pkt (empty request) or EOF.
 * Responses end with flush-pkt (stateful connection).
 */
async function handleV2SshCommandLoop<A>(
	reader: StreamPktLineReader,
	writer: WritableStreamDefaultWriter<Uint8Array>,
	repo: GitRepo,
	repoId: string,
	options: V2SshCommandLoopOptions<A>,
): Promise<void> {
	const { hooks, packCache, packOptions, auth } = options;

	while (true) {
		const cmd = await readV2CommandFromStream(reader);
		if (!cmd) break;

		if (cmd.command === "ls-refs") {
			const result = await handleLsRefs(repo, repoId, cmd.args, hooks, auth);
			if (isRejection(result)) break;
			await writer.write(result);
		} else if (cmd.command === "fetch") {
			const result = await handleV2Fetch(repo, cmd.args, {
				cache: packCache,
				cacheKey: repoId,
				noDelta: packOptions?.noDelta,
				deltaWindow: packOptions?.deltaWindow,
			});
			await writeResponse(writer, result);
		} else {
			// Unknown command — silently ignore per v2 spec
			break;
		}
	}
}

interface V2StreamCommand {
	command: string;
	capabilities: string[];
	args: string[];
}

/**
 * Read a single v2 command request from the SSH stream.
 * Returns null on flush-pkt (empty request) or EOF.
 */
async function readV2CommandFromStream(
	reader: StreamPktLineReader,
): Promise<V2StreamCommand | null> {
	let command = "";
	const capabilities: string[] = [];
	const args: string[] = [];
	let inArgs = false;
	let gotAny = false;

	while (true) {
		const line = await reader.readPktLine();
		if (!line) return gotAny ? { command, capabilities, args } : null;

		if (line.type === "flush") {
			// Flush before any data = empty request (client done)
			if (!gotAny) return null;
			break;
		}
		if (line.type === "response-end") break;
		if (line.type === "delim") {
			inArgs = true;
			continue;
		}

		gotAny = true;
		let text = line.text;
		if (text.endsWith("\n")) text = text.slice(0, -1);

		if (inArgs) {
			args.push(text);
		} else if (text.startsWith("command=")) {
			command = text.slice(8);
		} else {
			capabilities.push(text);
		}
	}

	return command ? { command, capabilities, args } : null;
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
