import { hexAt } from "../hex.ts";
import type { ObjectId, ObjectType, RawObject } from "../types.ts";
import { PackIndex } from "./pack-index.ts";
import { applyDelta } from "./packfile.ts";
import { inflate } from "./zlib.ts";

const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const TYPE_BY_NUM: Record<number, ObjectType> = {
	1: "commit",
	2: "tree",
	3: "blob",
	4: "tag",
};

/**
 * Random-access reader for a `.pack` + `.idx` pair.
 * Resolves objects (including deltas) on demand using the index
 * for O(log N) hash lookups.
 */
export class PackReader {
	private index: PackIndex;

	constructor(
		private data: Uint8Array,
		idx: Uint8Array | PackIndex,
	) {
		this.index = idx instanceof PackIndex ? idx : new PackIndex(idx);
	}

	hasObject(hash: ObjectId): boolean {
		return this.index.has(hash);
	}

	findByPrefix(prefix: string): ObjectId[] {
		return this.index.findByPrefix(prefix);
	}

	async readObject(hash: ObjectId): Promise<RawObject | null> {
		const offset = this.index.lookup(hash);
		if (offset === null) return null;
		return this.readAt(offset);
	}

	get objectCount(): number {
		return this.index.objectCount;
	}

	private async readAt(offset: number): Promise<RawObject> {
		const d = this.data;
		let pos = offset;

		let byte = d[pos++]!;
		const typeNum = (byte >> 4) & 0x07;
		let size = byte & 0x0f;
		let shift = 4;
		while (byte & 0x80) {
			byte = d[pos++]!;
			size |= (byte & 0x7f) << shift;
			shift += 7;
		}

		if (typeNum === OBJ_OFS_DELTA) {
			let c = d[pos++]!;
			let baseOff = c & 0x7f;
			while (c & 0x80) {
				baseOff += 1;
				c = d[pos++]!;
				baseOff = (baseOff << 7) + (c & 0x7f);
			}
			const inflated = await inflate(d.subarray(pos));
			const base = await this.readAt(offset - baseOff);
			return {
				type: base.type,
				content: applyDelta(base.content, inflated),
			};
		}

		if (typeNum === OBJ_REF_DELTA) {
			const baseHash = hexAt(d, pos);
			pos += 20;
			const inflated = await inflate(d.subarray(pos));
			const baseOffset = this.index.lookup(baseHash);
			if (baseOffset === null) {
				throw new Error(`REF_DELTA base ${baseHash} not found in pack`);
			}
			const base = await this.readAt(baseOffset);
			return {
				type: base.type,
				content: applyDelta(base.content, inflated),
			};
		}

		const type = TYPE_BY_NUM[typeNum];
		if (!type) throw new Error(`Unknown pack object type: ${typeNum}`);
		const content = await inflate(d.subarray(pos));
		if (content.byteLength !== size) {
			throw new Error(
				`Pack inflate size mismatch at offset ${offset}: got ${content.byteLength}, expected ${size}`,
			);
		}
		return { type, content };
	}
}
