/**
 * SSH protocol helpers for `createServer`'s `handleSession` method.
 *
 * Provides SSH command parsing and receive-pack streaming logic.
 * Shared request stream framing lives in `request-stream.ts`. Internal to the server module —
 * users interact via `GitServer.handleSession`.
 */

import { isRejection } from "../hooks.ts";
import type { GitRepo } from "../lib/types.ts";
import {
	PackCache,
	advertiseRefsWithHooks,
	buildAuthorizedFetchSet,
	buildRefListBytes,
	buildV2CapabilityAdvertisementBytes,
	handleLsRefs,
	handleUploadPack,
	handleV2Fetch,
	ingestReceivePackFromStream,
	applyReceivePackUpdates,
	runPostReceiveHook,
	type AuthorizedFetchSet,
	type ReceivePackLimitOptions,
} from "./operations.ts";
import { buildReportStatus } from "./protocol.ts";
import { ReceivePackOutput } from "./receive-output.ts";
import type { PushCommand } from "../lib/transport/smart-http.ts";
import type { ServerHooks, Auth, RefUpdate, SshChannel, Rejection } from "./types.ts";
import { RequestLimitError } from "./errors.ts";
import { StreamPktLineReader } from "./request-stream.ts";

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

interface FetchLimitOptions {
	maxRequestBytes?: number;
	maxInflatedBytes?: number;
}

interface HandleSessionOptions<A = Auth> {
	resolveRepo: (
		path: string,
	) => { repo: GitRepo; repoId: string } | null | Promise<{ repo: GitRepo; repoId: string } | null>;
	hooks?: ServerHooks<A>;
	packCache?: PackCache;
	packOptions?: { noDelta?: boolean; deltaWindow?: number };
	receiveKeepAliveMs?: number | false;
	receiveLimits?: ReceivePackLimitOptions;
	fetchLimits?: FetchLimitOptions;
	auth: A;
	/** Notified with the applied ref updates after a successful push. */
	onRefApplied?: (repoId: string, repo: GitRepo, applied: readonly RefUpdate[]) => void;
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
	const {
		resolveRepo,
		hooks,
		packCache,
		packOptions,
		receiveKeepAliveMs,
		receiveLimits,
		fetchLimits,
		auth,
	} = options;
	const onRefApplied = options.onRefApplied;
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
			if (isRejection(adv)) return sendRejection(channel, adv);

			await writer.write(buildV2CapabilityAdvertisementBytes());

			const streamReader = new StreamPktLineReader(channel.readable);
			try {
				return await handleV2SshCommandLoop(streamReader, writer, repo, repoId, channel, {
					hooks,
					packCache,
					packOptions,
					receiveLimits,
					fetchLimits,
					auth,
				});
			} finally {
				streamReader.release();
			}
		}

		// V2 not applicable for receive-pack — fall through to v1
		const adv = await advertiseRefsWithHooks(repo, repoId, service, hooks, auth);
		if (isRejection(adv)) return sendRejection(channel, adv);

		await writer.write(buildRefListBytes(adv.refs, service, adv.headTarget));

		const streamReader = new StreamPktLineReader(channel.readable);
		try {
			if (service === "git-upload-pack") {
				const authorizedFetchSet = hooks?.advertiseRefs ? buildAuthorizedFetchSet(adv) : undefined;
				const requestBody = await readUploadPackRequest(streamReader, fetchLimits?.maxRequestBytes);
				const result = await handleUploadPack(repo, requestBody, {
					cache: packCache,
					cacheKey: repoId,
					noDelta: packOptions?.noDelta,
					deltaWindow: packOptions?.deltaWindow,
					authorizedFetchSet,
				});
				if (isRejection(result)) return sendRejection(channel, result);
				await writeResponse(writer, result);
			} else {
				const { commands, capabilities, sawFlush } = await readReceivePackCommands(streamReader);
				const packStream = streamReader.streamRemaining();
				await serveReceivePackStreaming({
					writer,
					repo,
					repoId,
					commands,
					capabilities,
					sawFlush,
					packStream,
					channel,
					hooks,
					receiveKeepAliveMs,
					receiveLimits,
					auth,
					onRefApplied,
				});
			}
		} finally {
			streamReader.release();
		}

		return 0;
	} catch (err) {
		if (err instanceof RequestLimitError) {
			sendStderr(channel, `fatal: ${err.message}\n`);
			return 128;
		}
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
	sawFlush: boolean;
	packStream: AsyncIterable<Uint8Array>;
	channel: SshChannel;
	hooks?: ServerHooks<A>;
	receiveKeepAliveMs?: number | false;
	receiveLimits?: ReceivePackLimitOptions;
	auth: A;
	onRefApplied?: (repoId: string, repo: GitRepo, applied: readonly RefUpdate[]) => void;
}

async function serveReceivePackStreaming<A>(options: ServeReceivePackOptions<A>): Promise<void> {
	const {
		writer,
		repo,
		repoId,
		commands,
		capabilities,
		sawFlush,
		packStream,
		channel,
		hooks,
		receiveKeepAliveMs,
		receiveLimits,
		auth,
	} = options;
	const ingestResult = await ingestReceivePackFromStream(
		repo,
		commands,
		capabilities,
		packStream,
		sawFlush,
		receiveLimits,
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

	const output = new ReceivePackOutput({
		write: (data) => writer.write(data),
		useSideband,
		writeStderr: channel.writeStderr ? (data) => channel.writeStderr!(data) : undefined,
		keepAliveMs: receiveKeepAliveMs,
	});
	const applyOptions = {
		repo,
		repoId,
		ingestResult,
		hooks,
		auth,
		output: output.hookOutput,
	};

	output.startKeepAlive();
	try {
		const { refResults, applied } = await applyReceivePackUpdates(applyOptions);
		options.onRefApplied?.(repoId, repo, applied);

		if (useReportStatus) {
			const reportResults = refResults.map((r) => ({
				name: r.ref,
				ok: r.ok,
				error: r.error,
			}));
			await output.writeProtocol(buildReportStatus(true, reportResults, useSideband, false));
		}
		await runPostReceiveHook(applyOptions, applied);
		await output.finish();
	} catch (error) {
		try {
			await output.stop();
		} catch {
			// Preserve the receive-pack error.
		}
		throw error;
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

function sendStderr(channel: SshChannel, message: string): void {
	channel.writeStderr?.(encoder.encode(message));
}

function sendRejection(channel: SshChannel, r: Rejection): number {
	sendStderr(channel, `fatal: ${r.message ?? "access denied"}\n`);
	return 128;
}

// ── Protocol-aware stream reading ───────────────────────────────────

/**
 * Read an upload-pack request by parsing pkt-lines until "done".
 *
 * The git client keeps the SSH channel open during upload-pack — it
 * sends wants/haves/done and waits for the pack response without
 * sending EOF. We must stop reading at the protocol boundary.
 */
async function readUploadPackRequest(
	reader: StreamPktLineReader,
	maxBytes?: number,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		const line = await reader.readPktLine();
		if (!line) break;
		totalBytes += line.raw.byteLength;
		if (maxBytes !== undefined && totalBytes > maxBytes) {
			throw new RequestLimitError("Request body too large");
		}
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
): Promise<{ commands: PushCommand[]; capabilities: string[]; sawFlush: boolean }> {
	const commands: PushCommand[] = [];
	let capabilities: string[] = [];
	let first = true;
	let sawFlush = false;

	while (true) {
		const line = await reader.readPktLine();
		if (!line) break;
		if (line.type === "flush") {
			sawFlush = true;
			break;
		}
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

	return { commands, capabilities, sawFlush };
}

// ── V2 SSH command loop ─────────────────────────────────────────────

interface V2SshCommandLoopOptions<A> {
	hooks?: ServerHooks<A>;
	packCache?: PackCache;
	packOptions?: { noDelta?: boolean; deltaWindow?: number };
	receiveLimits?: ReceivePackLimitOptions;
	fetchLimits?: FetchLimitOptions;
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
	channel: SshChannel,
	options: V2SshCommandLoopOptions<A>,
): Promise<number> {
	const { hooks, packCache, packOptions, fetchLimits: fl, auth } = options;

	while (true) {
		const cmd = await readV2CommandFromStream(reader, fl?.maxRequestBytes);
		if (!cmd) break;

		if (cmd.command === "ls-refs") {
			const result = await handleLsRefs(repo, repoId, cmd.args, hooks, auth);
			if (isRejection(result)) return sendRejection(channel, result);
			await writer.write(result);
		} else if (cmd.command === "fetch") {
			let authorizedFetchSet: AuthorizedFetchSet | undefined;
			if (hooks?.advertiseRefs) {
				const adv = await advertiseRefsWithHooks(repo, repoId, "git-upload-pack", hooks, auth);
				if (isRejection(adv)) return sendRejection(channel, adv);
				authorizedFetchSet = buildAuthorizedFetchSet(adv);
			}
			const result = await handleV2Fetch(repo, cmd.args, {
				cache: packCache,
				cacheKey: repoId,
				noDelta: packOptions?.noDelta,
				deltaWindow: packOptions?.deltaWindow,
				authorizedFetchSet,
			});
			if (isRejection(result)) return sendRejection(channel, result);
			await writeResponse(writer, result);
		} else {
			// Unknown command — silently ignore per v2 spec
			break;
		}
	}

	return 0;
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
	maxBytes?: number,
): Promise<V2StreamCommand | null> {
	let command = "";
	const capabilities: string[] = [];
	const args: string[] = [];
	let inArgs = false;
	let gotAny = false;
	let totalBytes = 0;

	while (true) {
		const line = await reader.readPktLine();
		if (!line) return gotAny ? { command, capabilities, args } : null;

		if (line.type === "flush") {
			if (!gotAny) return null;
			break;
		}
		if (line.type === "response-end") break;

		totalBytes += line.raw.byteLength;
		if (maxBytes !== undefined && totalBytes > maxBytes) {
			throw new RequestLimitError("Request body too large");
		}

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
