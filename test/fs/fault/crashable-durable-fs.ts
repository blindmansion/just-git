import type { DurableFileSystem, FileStat } from "../../../src/fs/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;

type Inode =
	| { kind: "file"; content: Uint8Array; durableContent: Uint8Array; mtime: Date }
	| {
			kind: "directory";
			entries: Map<string, number>;
			durableEntries: Map<string, number>;
			mtime: Date;
	  };

interface ModelState {
	nextInode: number;
	root: number;
	inodes: Map<number, Inode>;
}

export type DurableFsOperation = "mkdir" | "writeFile" | "link" | "rename" | "rm" | "fsync";

export interface DurableFsEvent {
	operation: DurableFsOperation;
	path: string;
	destination?: string;
}

export interface DurableFsSnapshot {
	readonly state: ModelState;
}

/** A simulated process crash. Cleanup after this error cannot mutate the filesystem. */
export class SimulatedCrashError extends Error {
	constructor(readonly event?: DurableFsEvent) {
		super(
			event ? `simulated crash after ${formatEvent(event)}` : "simulated crash before operation",
		);
		this.name = "SimulatedCrashError";
	}
}

/**
 * Test-only inode filesystem with independently tracked live and durable state.
 *
 * File fsync persists inode contents. Directory fsync persists only that
 * directory's immediate namespace. Reboot reconstructs live state solely from
 * those durable values.
 */
export class CrashableDurableFileSystem implements DurableFileSystem {
	private state: ModelState;
	private frozen = false;
	private crashAfterEvent: number | undefined;
	private readonly eventLog: DurableFsEvent[] = [];

	constructor(snapshot?: DurableFsSnapshot) {
		if (snapshot) {
			this.state = cloneState(snapshot.state, true);
			return;
		}
		const root = 1;
		this.state = {
			nextInode: root + 1,
			root,
			inodes: new Map([
				[
					root,
					{
						kind: "directory",
						entries: new Map(),
						durableEntries: new Map(),
						mtime: new Date(0),
					},
				],
			]),
		};
	}

	/** Persist the complete current tree and return a reusable replay baseline. */
	checkpoint(): DurableFsSnapshot {
		this.assertRunning();
		for (const inode of this.state.inodes.values()) {
			if (inode.kind === "file") inode.durableContent = cloneBytes(inode.content);
			else inode.durableEntries = new Map(inode.entries);
		}
		this.eventLog.length = 0;
		return { state: cloneState(this.state, false) };
	}

	/** Crash after the Nth recorded mutation/fsync (one-based). */
	armCrashAfter(eventNumber: number): void {
		if (!Number.isInteger(eventNumber) || eventNumber < 1) {
			throw new RangeError("eventNumber must be a positive integer");
		}
		this.crashAfterEvent = eventNumber;
	}

	/** Simulate the cut immediately before a scenario operation. */
	crashBeforeOperation(): never {
		this.assertRunning();
		this.frozen = true;
		throw new SimulatedCrashError();
	}

	get events(): readonly DurableFsEvent[] {
		return this.eventLog;
	}

	/** Return a fresh process view reconstructed only from durable state. */
	reboot(): CrashableDurableFileSystem {
		return new CrashableDurableFileSystem({ state: durableState(this.state) });
	}

	async readFile(path: string): Promise<string> {
		return decoder.decode(await this.readFileBuffer(path));
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		this.assertRunning();
		const inode = this.lookup(path);
		if (inode.kind !== "file") throw fsError("EISDIR", "read", path);
		return cloneBytes(inode.content);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		this.assertRunning();
		const { parent, name } = this.lookupParent(path);
		const existingId = parent.entries.get(name);
		const bytes = typeof content === "string" ? encoder.encode(content) : cloneBytes(content);
		if (existingId !== undefined) {
			const existing = this.inode(existingId);
			if (existing.kind !== "file") throw fsError("EISDIR", "write", path);
			existing.content = bytes;
			existing.mtime = new Date();
		} else {
			const id = this.state.nextInode++;
			this.state.inodes.set(id, {
				kind: "file",
				content: bytes,
				durableContent: new Uint8Array(),
				mtime: new Date(),
			});
			parent.entries.set(name, id);
		}
		this.record({ operation: "writeFile", path: normalize(path) });
	}

	async exists(path: string): Promise<boolean> {
		this.assertRunning();
		try {
			this.lookup(path);
			return true;
		} catch {
			return false;
		}
	}

	async stat(path: string): Promise<FileStat> {
		this.assertRunning();
		const inode = this.lookup(path);
		return {
			isFile: inode.kind === "file",
			isDirectory: inode.kind === "directory",
			isSymbolicLink: false,
			mode: inode.kind === "file" ? FILE_MODE : DIR_MODE,
			size: inode.kind === "file" ? inode.content.byteLength : 0,
			mtime: inode.mtime,
		};
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		this.assertRunning();
		const normalized = normalize(path);
		if (normalized === "/") {
			if (options?.recursive) return;
			throw fsError("EEXIST", "mkdir", path);
		}
		if (options?.recursive) {
			let current = "";
			for (const part of parts(normalized)) {
				current += `/${part}`;
				if (!(await this.exists(current))) await this.mkdir(current);
			}
			return;
		}
		const { parent, name } = this.lookupParent(normalized);
		if (parent.entries.has(name)) throw fsError("EEXIST", "mkdir", path);
		const id = this.state.nextInode++;
		this.state.inodes.set(id, {
			kind: "directory",
			entries: new Map(),
			durableEntries: new Map(),
			mtime: new Date(),
		});
		parent.entries.set(name, id);
		this.record({ operation: "mkdir", path: normalized });
	}

	async readdir(path: string): Promise<string[]> {
		this.assertRunning();
		const inode = this.lookup(path);
		if (inode.kind !== "directory") throw fsError("ENOTDIR", "scandir", path);
		return [...inode.entries.keys()].sort();
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		this.assertRunning();
		const normalized = normalize(path);
		if (normalized === "/") throw fsError("EPERM", "rm", path);
		let parent: Extract<Inode, { kind: "directory" }>;
		let name: string;
		try {
			({ parent, name } = this.lookupParent(normalized));
		} catch (error) {
			if (options?.force && isCode(error, "ENOENT")) return;
			throw error;
		}
		const id = parent.entries.get(name);
		if (id === undefined) {
			if (options?.force) return;
			throw fsError("ENOENT", "rm", path);
		}
		const inode = this.inode(id);
		if (inode.kind === "directory" && inode.entries.size > 0 && !options?.recursive) {
			throw fsError("ENOTEMPTY", "rm", path);
		}
		parent.entries.delete(name);
		this.record({ operation: "rm", path: normalized });
	}

	async fsync(path: string): Promise<void> {
		this.assertRunning();
		const normalized = normalize(path);
		const inode = this.lookup(normalized);
		if (inode.kind === "file") inode.durableContent = cloneBytes(inode.content);
		else inode.durableEntries = new Map(inode.entries);
		this.record({ operation: "fsync", path: normalized });
	}

	async rename(src: string, dest: string): Promise<void> {
		this.assertRunning();
		const from = normalize(src);
		const to = normalize(dest);
		if (from === to) return;
		const source = this.lookupParent(from);
		const id = source.parent.entries.get(source.name);
		if (id === undefined) throw fsError("ENOENT", "rename", src);
		const target = this.lookupParent(to);
		const targetId = target.parent.entries.get(target.name);
		if (targetId !== undefined) {
			const sourceInode = this.inode(id);
			const targetInode = this.inode(targetId);
			if (sourceInode.kind === "directory" && targetInode.kind === "file") {
				throw fsError("ENOTDIR", "rename", dest);
			}
			if (sourceInode.kind === "file" && targetInode.kind === "directory") {
				throw fsError("EISDIR", "rename", dest);
			}
			if (targetInode.kind === "directory" && targetInode.entries.size > 0) {
				throw fsError("ENOTEMPTY", "rename", dest);
			}
		}
		source.parent.entries.delete(source.name);
		target.parent.entries.set(target.name, id);
		this.record({ operation: "rename", path: from, destination: to });
	}

	async link(existingPath: string, newPath: string): Promise<void> {
		this.assertRunning();
		const source = this.lookup(existingPath);
		if (source.kind !== "file") throw fsError("EPERM", "link", existingPath);
		const sourceId = this.lookupId(existingPath);
		const { parent, name } = this.lookupParent(newPath);
		if (parent.entries.has(name)) throw fsError("EEXIST", "link", newPath);
		parent.entries.set(name, sourceId);
		this.record({
			operation: "link",
			path: normalize(existingPath),
			destination: normalize(newPath),
		});
	}

	async mv(src: string, dest: string): Promise<void> {
		await this.rename(src, dest);
	}

	/** A compact durable/live namespace dump for crash diagnostics. */
	dumpTree(): string {
		const lines: string[] = [];
		const walk = (id: number, path: string, seen: Set<number>) => {
			const inode = this.inode(id);
			if (inode.kind === "file") {
				lines.push(`${path} = ${JSON.stringify(decoder.decode(inode.content))}`);
				return;
			}
			lines.push(`${path}/`);
			if (seen.has(id)) return;
			seen.add(id);
			for (const [name, child] of [...inode.entries].sort(([a], [b]) => a.localeCompare(b))) {
				walk(child, path === "/" ? `/${name}` : `${path}/${name}`, seen);
			}
		};
		walk(this.state.root, "/", new Set());
		return lines.join("\n");
	}

	private lookup(path: string): Inode {
		return this.inode(this.lookupId(path));
	}

	private lookupId(path: string): number {
		let id = this.state.root;
		for (const part of parts(normalize(path))) {
			const inode = this.inode(id);
			if (inode.kind !== "directory") throw fsError("ENOTDIR", "stat", path);
			const child = inode.entries.get(part);
			if (child === undefined) throw fsError("ENOENT", "stat", path);
			id = child;
		}
		return id;
	}

	private lookupParent(path: string): {
		parent: Extract<Inode, { kind: "directory" }>;
		name: string;
	} {
		const normalized = normalize(path);
		const segments = parts(normalized);
		const name = segments.pop();
		if (!name) throw fsError("EINVAL", "path", path);
		const parentPath = segments.length === 0 ? "/" : `/${segments.join("/")}`;
		const parent = this.lookup(parentPath);
		if (parent.kind !== "directory") throw fsError("ENOTDIR", "path", parentPath);
		return { parent, name };
	}

	private inode(id: number): Inode {
		const inode = this.state.inodes.get(id);
		if (!inode) throw new Error(`corrupt test filesystem: missing inode ${id}`);
		return inode;
	}

	private record(event: DurableFsEvent): void {
		this.eventLog.push(event);
		if (this.eventLog.length === this.crashAfterEvent) {
			this.frozen = true;
			throw new SimulatedCrashError(event);
		}
	}

	private assertRunning(): void {
		if (this.frozen) throw new SimulatedCrashError(this.eventLog.at(-1));
	}
}

export function formatEvent(event: DurableFsEvent): string {
	const source = normalizeTemporaryPath(event.path);
	const destination = event.destination ? ` -> ${normalizeTemporaryPath(event.destination)}` : "";
	return `${event.operation} ${source}${destination}`;
}

function normalizeTemporaryPath(path: string): string {
	return path.replace(/\.tmp-[^/]+/g, ".tmp-<nonce>");
}

function normalize(path: string): string {
	const normalized: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") normalized.pop();
		else normalized.push(part);
	}
	return `/${normalized.join("/")}`;
}

function parts(path: string): string[] {
	return path === "/" ? [] : path.slice(1).split("/");
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

function cloneState(state: ModelState, reboot: boolean): ModelState {
	const inodes = new Map<number, Inode>();
	for (const [id, inode] of state.inodes) {
		if (inode.kind === "file") {
			const durableContent = cloneBytes(inode.durableContent);
			inodes.set(id, {
				kind: "file",
				content: reboot ? cloneBytes(durableContent) : cloneBytes(inode.content),
				durableContent,
				mtime: new Date(inode.mtime),
			});
		} else {
			const durableEntries = new Map(inode.durableEntries);
			inodes.set(id, {
				kind: "directory",
				entries: reboot ? new Map(durableEntries) : new Map(inode.entries),
				durableEntries,
				mtime: new Date(inode.mtime),
			});
		}
	}
	return { nextInode: state.nextInode, root: state.root, inodes };
}

function durableState(state: ModelState): ModelState {
	return cloneState(state, true);
}

function fsError(code: string, operation: string, path: string): Error & { code: string } {
	return Object.assign(new Error(`${code}: ${operation} '${path}'`), { code });
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
