import { flushPkt } from "../lib/transport/pkt-line.ts";
import { encodeSidebandPackets } from "./protocol.ts";
import type { HookOutput } from "./types.ts";

const encoder = new TextEncoder();

export const NOOP_HOOK_OUTPUT: HookOutput = {
	async write(): Promise<void> {},
	async writeLine(): Promise<void> {},
};

export interface ReceivePackOutputOptions {
	write(data: Uint8Array): Promise<void>;
	useSideband: boolean;
	writeStderr?(data: Uint8Array): void;
	keepAliveMs?: number | false;
}

/**
 * Serializes receive-pack protocol and hook output onto the transport.
 * Hook output uses sideband channel 2 when available, otherwise SSH stderr.
 */
export class ReceivePackOutput {
	readonly hookOutput: HookOutput;

	private queue: Promise<void> = Promise.resolve();
	private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
	private keepAliveActive = false;
	private finished = false;
	private readonly keepAliveMs: number | false;

	constructor(private readonly options: ReceivePackOutputOptions) {
		this.keepAliveMs = normalizeKeepAlive(options.keepAliveMs);
		this.hookOutput = {
			write: (data) => this.writeHook(data),
			writeLine: (message = "") => this.writeHook(`${message}\n`),
		};
	}

	startKeepAlive(): void {
		if (!this.options.useSideband || this.keepAliveMs === false || this.finished) return;
		this.keepAliveActive = true;
		this.armKeepAlive();
	}

	async writeProtocol(data: Uint8Array): Promise<void> {
		await this.enqueue(() => this.options.write(data), true);
	}

	async finish(): Promise<void> {
		if (this.finished) return;
		this.finished = true;
		this.keepAliveActive = false;
		this.clearKeepAlive();
		await this.queue;
		if (this.options.useSideband) {
			await this.enqueue(() => this.options.write(flushPkt()), false);
		}
	}

	async stop(): Promise<void> {
		this.finished = true;
		this.keepAliveActive = false;
		this.clearKeepAlive();
		await this.queue;
	}

	private writeHook(data: string | Uint8Array): Promise<void> {
		const bytes = typeof data === "string" ? encoder.encode(data) : data;
		if (this.options.useSideband) {
			const packets = encodeSidebandPackets(2, bytes);
			return this.enqueue(async () => {
				for (const packet of packets) await this.options.write(packet);
			}, true);
		}
		if (this.options.writeStderr) {
			return this.enqueue(async () => {
				this.options.writeStderr!(bytes);
			}, false);
		}
		return Promise.resolve();
	}

	private enqueue(action: () => Promise<void>, resetKeepAlive: boolean): Promise<void> {
		if (this.finished && resetKeepAlive)
			return Promise.reject(new Error("Receive-pack output is closed"));
		if (resetKeepAlive) this.clearKeepAlive();

		const next = this.queue.then(action);
		this.queue = next;
		void next.catch(() => {});

		if (resetKeepAlive && this.keepAliveActive) {
			void next.then(
				() => this.armKeepAlive(),
				() => {},
			);
		}
		return next;
	}

	private armKeepAlive(): void {
		if (!this.keepAliveActive || this.keepAliveMs === false || this.finished) return;
		this.clearKeepAlive();
		this.keepAliveTimer = setTimeout(() => {
			this.keepAliveTimer = undefined;
			const keepAlive = encodeSidebandPackets(1, new Uint8Array(0))[0]!;
			const write = this.enqueue(() => this.options.write(keepAlive), false);
			void write.then(
				() => this.armKeepAlive(),
				() => {},
			);
		}, this.keepAliveMs);
	}

	private clearKeepAlive(): void {
		if (this.keepAliveTimer !== undefined) {
			clearTimeout(this.keepAliveTimer);
			this.keepAliveTimer = undefined;
		}
	}
}

function normalizeKeepAlive(value: number | false | undefined): number | false {
	if (value === false) return false;
	if (value === undefined) return 5000;
	if (!Number.isFinite(value) || value <= 0) return false;
	return value;
}
