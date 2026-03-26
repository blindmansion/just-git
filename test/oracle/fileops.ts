/**
 * File operation serialization for oracle traces.
 *
 * Three categories:
 *   FILE_BATCH:<seed>    — seed-based random file op batch (regenerated at replay time)
 *   FILE_RESOLVE:<seed>  — seed-based resolve-all-files (conflict resolution, regenerated at replay time)
 *   FILE_WRITE:<json>    — individual write (legacy, used by initial seed file)
 *   FILE_DELETE:<json>    — individual delete (legacy)
 */

// ── Individual op types (for conflict resolution writes) ─────────────

interface WriteOp {
	type: "write";
	path: string;
	content: string;
	offset?: number;
	deleteCount?: number;
}

interface DeleteOp {
	type: "delete";
	path: string;
}

type FileOp = WriteOp | DeleteOp;

// ── Prefixes ─────────────────────────────────────────────────────────

const FILE_BATCH_PREFIX = "FILE_BATCH:";
const FILE_RESOLVE_PREFIX = "FILE_RESOLVE:";
const WRITE_PREFIX = "FILE_WRITE:";
const DELETE_PREFIX = "FILE_DELETE:";

// ── Detection ────────────────────────────────────────────────────────

/** Is this a seed-based file op batch? */
export function isFileOpBatch(command: string): boolean {
	return command.startsWith(FILE_BATCH_PREFIX);
}

/** Is this a seed-based resolve-all-files op? */
export function isFileResolve(command: string): boolean {
	return command.startsWith(FILE_RESOLVE_PREFIX);
}

/** Is this an individual (non-batch) file op? */
export function isIndividualFileOp(command: string): boolean {
	return command.startsWith(WRITE_PREFIX) || command.startsWith(DELETE_PREFIX);
}

// ── Batch seed ───────────────────────────────────────────────────────

/** Serialize a file op batch as a command string. */
export function serializeFileOpBatch(seed: number): string {
	return `${FILE_BATCH_PREFIX}${seed}`;
}

/** Extract the seed from a FILE_BATCH command. */
export function parseFileOpBatchSeed(command: string): number {
	return parseInt(command.slice(FILE_BATCH_PREFIX.length), 10);
}

/** Serialize a resolve-all-files op as a command string. */
export function serializeFileResolve(seed: number): string {
	return `${FILE_RESOLVE_PREFIX}${seed}`;
}

/** Extract the seed from a FILE_RESOLVE command. */
export function parseFileResolveSeed(command: string): number {
	return parseInt(command.slice(FILE_RESOLVE_PREFIX.length), 10);
}

// ── Individual op parse/serialize ────────────────────────────────────

export function parseFileOp(command: string): FileOp {
	if (command.startsWith(WRITE_PREFIX)) {
		const data = JSON.parse(command.slice(WRITE_PREFIX.length));
		return { type: "write", ...data };
	}
	if (command.startsWith(DELETE_PREFIX)) {
		const data = JSON.parse(command.slice(DELETE_PREFIX.length));
		return { type: "delete", ...data };
	}
	throw new Error(`Unknown file op prefix: ${command.slice(0, 20)}`);
}

function serializeFileOp(op: FileOp): string {
	switch (op.type) {
		case "write": {
			const { type: _, ...data } = op;
			return WRITE_PREFIX + JSON.stringify(data);
		}
		case "delete": {
			const { type: _, ...data } = op;
			return DELETE_PREFIX + JSON.stringify(data);
		}
	}
}

// ── Convenience builders ─────────────────────────────────────────────

/** Serialize a write/splice op. */
export function write(
	path: string,
	content: string,
	offset?: number,
	deleteCount?: number,
): string {
	const op: WriteOp = { type: "write", path, content };
	if (offset !== undefined) op.offset = offset;
	if (deleteCount !== undefined) op.deleteCount = deleteCount;
	return serializeFileOp(op);
}

/** Serialize a delete op. */
export function del(path: string): string {
	return serializeFileOp({ type: "delete", path });
}

// ── Git command classification ───────────────────────────────────────

/**
 * Detect git commands that create commits (need incrementing timestamps).
 * Handles both stored format ("git commit ...") and bare format ("commit ...").
 */
export function isCommitCommand(command: string): boolean {
	const lower = command.toLowerCase().replace(/^git\s+/, "");
	return (
		lower.startsWith("commit") ||
		lower.startsWith("merge") ||
		lower.startsWith("cherry-pick") ||
		lower.startsWith("revert") ||
		lower.startsWith("pull") ||
		lower.includes("rebase --continue")
	);
}
