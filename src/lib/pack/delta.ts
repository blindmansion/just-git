import type { ObjectId, ObjectType } from "../types.ts";

// ── Rabin fingerprint tables ─────────────────────────────────────────
// From git's diff-delta.c — fixed mathematical constants for the Rabin
// polynomial rolling hash (window=16, shift=23).

const RABIN_SHIFT = 23;
const RABIN_WINDOW = 16;

// prettier-ignore
const T = new Uint32Array([
	0x00000000, 0xab59b4d1, 0x56b369a2, 0xfdeadd73, 0x063f6795, 0xad66d344,
	0x508c0e37, 0xfbd5bae6, 0x0c7ecf2a, 0xa7277bfb, 0x5acda688, 0xf1941259,
	0x0a41a8bf, 0xa1181c6e, 0x5cf2c11d, 0xf7ab75cc, 0x18fd9e54, 0xb3a42a85,
	0x4e4ef7f6, 0xe5174327, 0x1ec2f9c1, 0xb59b4d10, 0x48719063, 0xe32824b2,
	0x1483517e, 0xbfdae5af, 0x423038dc, 0xe9698c0d, 0x12bc36eb, 0xb9e5823a,
	0x440f5f49, 0xef56eb98, 0x31fb3ca8, 0x9aa28879, 0x6748550a, 0xcc11e1db,
	0x37c45b3d, 0x9c9defec, 0x6177329f, 0xca2e864e, 0x3d85f382, 0x96dc4753,
	0x6b369a20, 0xc06f2ef1, 0x3bba9417, 0x90e320c6, 0x6d09fdb5, 0xc6504964,
	0x2906a2fc, 0x825f162d, 0x7fb5cb5e, 0xd4ec7f8f, 0x2f39c569, 0x846071b8,
	0x798aaccb, 0xd2d3181a, 0x25786dd6, 0x8e21d907, 0x73cb0474, 0xd892b0a5,
	0x23470a43, 0x881ebe92, 0x75f463e1, 0xdeadd730, 0x63f67950, 0xc8afcd81,
	0x354510f2, 0x9e1ca423, 0x65c91ec5, 0xce90aa14, 0x337a7767, 0x9823c3b6,
	0x6f88b67a, 0xc4d102ab, 0x393bdfd8, 0x92626b09, 0x69b7d1ef, 0xc2ee653e,
	0x3f04b84d, 0x945d0c9c, 0x7b0be704, 0xd05253d5, 0x2db88ea6, 0x86e13a77,
	0x7d348091, 0xd66d3440, 0x2b87e933, 0x80de5de2, 0x7775282e, 0xdc2c9cff,
	0x21c6418c, 0x8a9ff55d, 0x714a4fbb, 0xda13fb6a, 0x27f92619, 0x8ca092c8,
	0x520d45f8, 0xf954f129, 0x04be2c5a, 0xafe7988b, 0x5432226d, 0xff6b96bc,
	0x02814bcf, 0xa9d8ff1e, 0x5e738ad2, 0xf52a3e03, 0x08c0e370, 0xa39957a1,
	0x584ced47, 0xf3155996, 0x0eff84e5, 0xa5a63034, 0x4af0dbac, 0xe1a96f7d,
	0x1c43b20e, 0xb71a06df, 0x4ccfbc39, 0xe79608e8, 0x1a7cd59b, 0xb125614a,
	0x468e1486, 0xedd7a057, 0x103d7d24, 0xbb64c9f5, 0x40b17313, 0xebe8c7c2,
	0x16021ab1, 0xbd5bae60, 0x6cb54671, 0xc7ecf2a0, 0x3a062fd3, 0x915f9b02,
	0x6a8a21e4, 0xc1d39535, 0x3c394846, 0x9760fc97, 0x60cb895b, 0xcb923d8a,
	0x3678e0f9, 0x9d215428, 0x66f4eece, 0xcdad5a1f, 0x3047876c, 0x9b1e33bd,
	0x7448d825, 0xdf116cf4, 0x22fbb187, 0x89a20556, 0x7277bfb0, 0xd92e0b61,
	0x24c4d612, 0x8f9d62c3, 0x7836170f, 0xd36fa3de, 0x2e857ead, 0x85dcca7c,
	0x7e09709a, 0xd550c44b, 0x28ba1938, 0x83e3ade9, 0x5d4e7ad9, 0xf617ce08,
	0x0bfd137b, 0xa0a4a7aa, 0x5b711d4c, 0xf028a99d, 0x0dc274ee, 0xa69bc03f,
	0x5130b5f3, 0xfa690122, 0x0783dc51, 0xacda6880, 0x570fd266, 0xfc5666b7,
	0x01bcbbc4, 0xaae50f15, 0x45b3e48d, 0xeeea505c, 0x13008d2f, 0xb85939fe,
	0x438c8318, 0xe8d537c9, 0x153feaba, 0xbe665e6b, 0x49cd2ba7, 0xe2949f76,
	0x1f7e4205, 0xb427f6d4, 0x4ff24c32, 0xe4abf8e3, 0x19412590, 0xb2189141,
	0x0f433f21, 0xa41a8bf0, 0x59f05683, 0xf2a9e252, 0x097c58b4, 0xa225ec65,
	0x5fcf3116, 0xf49685c7, 0x033df00b, 0xa86444da, 0x558e99a9, 0xfed72d78,
	0x0502979e, 0xae5b234f, 0x53b1fe3c, 0xf8e84aed, 0x17bea175, 0xbce715a4,
	0x410dc8d7, 0xea547c06, 0x1181c6e0, 0xbad87231, 0x4732af42, 0xec6b1b93,
	0x1bc06e5f, 0xb099da8e, 0x4d7307fd, 0xe62ab32c, 0x1dff09ca, 0xb6a6bd1b,
	0x4b4c6068, 0xe015d4b9, 0x3eb80389, 0x95e1b758, 0x680b6a2b, 0xc352defa,
	0x3887641c, 0x93ded0cd, 0x6e340dbe, 0xc56db96f, 0x32c6cca3, 0x999f7872,
	0x6475a501, 0xcf2c11d0, 0x34f9ab36, 0x9fa01fe7, 0x624ac294, 0xc9137645,
	0x26459ddd, 0x8d1c290c, 0x70f6f47f, 0xdbaf40ae, 0x207afa48, 0x8b234e99,
	0x76c993ea, 0xdd90273b, 0x2a3b52f7, 0x8162e626, 0x7c883b55, 0xd7d18f84,
	0x2c043562, 0x875d81b3, 0x7ab75cc0, 0xd1eee811,
]);

// prettier-ignore
const U = new Uint32Array([
	0x00000000, 0x7eb5200d, 0x5633f4cb, 0x2886d4c6, 0x073e5d47, 0x798b7d4a,
	0x510da98c, 0x2fb88981, 0x0e7cba8e, 0x70c99a83, 0x584f4e45, 0x26fa6e48,
	0x0942e7c9, 0x77f7c7c4, 0x5f711302, 0x21c4330f, 0x1cf9751c, 0x624c5511,
	0x4aca81d7, 0x347fa1da, 0x1bc7285b, 0x65720856, 0x4df4dc90, 0x3341fc9d,
	0x1285cf92, 0x6c30ef9f, 0x44b63b59, 0x3a031b54, 0x15bb92d5, 0x6b0eb2d8,
	0x4388661e, 0x3d3d4613, 0x39f2ea38, 0x4747ca35, 0x6fc11ef3, 0x11743efe,
	0x3eccb77f, 0x40799772, 0x68ff43b4, 0x164a63b9, 0x378e50b6, 0x493b70bb,
	0x61bda47d, 0x1f088470, 0x30b00df1, 0x4e052dfc, 0x6683f93a, 0x1836d937,
	0x250b9f24, 0x5bbebf29, 0x73386bef, 0x0d8d4be2, 0x2235c263, 0x5c80e26e,
	0x740636a8, 0x0ab316a5, 0x2b7725aa, 0x55c205a7, 0x7d44d161, 0x03f1f16c,
	0x2c4978ed, 0x52fc58e0, 0x7a7a8c26, 0x04cfac2b, 0x73e5d470, 0x0d50f47d,
	0x25d620bb, 0x5b6300b6, 0x74db8937, 0x0a6ea93a, 0x22e87dfc, 0x5c5d5df1,
	0x7d996efe, 0x032c4ef3, 0x2baa9a35, 0x551fba38, 0x7aa733b9, 0x041213b4,
	0x2c94c772, 0x5221e77f, 0x6f1ca16c, 0x11a98161, 0x392f55a7, 0x479a75aa,
	0x6822fc2b, 0x1697dc26, 0x3e1108e0, 0x40a428ed, 0x61601be2, 0x1fd53bef,
	0x3753ef29, 0x49e6cf24, 0x665e46a5, 0x18eb66a8, 0x306db26e, 0x4ed89263,
	0x4a173e48, 0x34a21e45, 0x1c24ca83, 0x6291ea8e, 0x4d29630f, 0x339c4302,
	0x1b1a97c4, 0x65afb7c9, 0x446b84c6, 0x3adea4cb, 0x1258700d, 0x6ced5000,
	0x4355d981, 0x3de0f98c, 0x15662d4a, 0x6bd30d47, 0x56ee4b54, 0x285b6b59,
	0x00ddbf9f, 0x7e689f92, 0x51d01613, 0x2f65361e, 0x07e3e2d8, 0x7956c2d5,
	0x5892f1da, 0x2627d1d7, 0x0ea10511, 0x7014251c, 0x5facac9d, 0x21198c90,
	0x099f5856, 0x772a785b, 0x4c921c31, 0x32273c3c, 0x1aa1e8fa, 0x6414c8f7,
	0x4bac4176, 0x3519617b, 0x1d9fb5bd, 0x632a95b0, 0x42eea6bf, 0x3c5b86b2,
	0x14dd5274, 0x6a687279, 0x45d0fbf8, 0x3b65dbf5, 0x13e30f33, 0x6d562f3e,
	0x506b692d, 0x2ede4920, 0x06589de6, 0x78edbdeb, 0x5755346a, 0x29e01467,
	0x0166c0a1, 0x7fd3e0ac, 0x5e17d3a3, 0x20a2f3ae, 0x08242768, 0x76910765,
	0x59298ee4, 0x279caee9, 0x0f1a7a2f, 0x71af5a22, 0x7560f609, 0x0bd5d604,
	0x235302c2, 0x5de622cf, 0x725eab4e, 0x0ceb8b43, 0x246d5f85, 0x5ad87f88,
	0x7b1c4c87, 0x05a96c8a, 0x2d2fb84c, 0x539a9841, 0x7c2211c0, 0x029731cd,
	0x2a11e50b, 0x54a4c506, 0x69998315, 0x172ca318, 0x3faa77de, 0x411f57d3,
	0x6ea7de52, 0x1012fe5f, 0x38942a99, 0x46210a94, 0x67e5399b, 0x19501996,
	0x31d6cd50, 0x4f63ed5d, 0x60db64dc, 0x1e6e44d1, 0x36e89017, 0x485db01a,
	0x3f77c841, 0x41c2e84c, 0x69443c8a, 0x17f11c87, 0x38499506, 0x46fcb50b,
	0x6e7a61cd, 0x10cf41c0, 0x310b72cf, 0x4fbe52c2, 0x67388604, 0x198da609,
	0x36352f88, 0x48800f85, 0x6006db43, 0x1eb3fb4e, 0x238ebd5d, 0x5d3b9d50,
	0x75bd4996, 0x0b08699b, 0x24b0e01a, 0x5a05c017, 0x728314d1, 0x0c3634dc,
	0x2df207d3, 0x534727de, 0x7bc1f318, 0x0574d315, 0x2acc5a94, 0x54797a99,
	0x7cffae5f, 0x024a8e52, 0x06852279, 0x78300274, 0x50b6d6b2, 0x2e03f6bf,
	0x01bb7f3e, 0x7f0e5f33, 0x57888bf5, 0x293dabf8, 0x08f998f7, 0x764cb8fa,
	0x5eca6c3c, 0x207f4c31, 0x0fc7c5b0, 0x7172e5bd, 0x59f4317b, 0x27411176,
	0x1a7c5765, 0x64c97768, 0x4c4fa3ae, 0x32fa83a3, 0x1d420a22, 0x63f72a2f,
	0x4b71fee9, 0x35c4dee4, 0x1400edeb, 0x6ab5cde6, 0x42331920, 0x3c86392d,
	0x133eb0ac, 0x6d8b90a1, 0x450d4467, 0x3bb8646a,
]);

// ── Constants ────────────────────────────────────────────────────────

const HASH_LIMIT = 64;
const MIN_COPY_SIZE = 4;
const GOOD_ENOUGH_MATCH = 4096;
const MAX_COPY_SIZE = 0x10000; // 64KB
const MAX_INSERT_SIZE = 0x7f; // 127

// ── Types ────────────────────────────────────────────────────────────

interface IndexEntry {
	/** Pointer offset into the source buffer (end of the 16-byte block). */
	ptr: number;
	/** Rabin hash value for this block. */
	val: number;
}

interface DeltaIndex {
	readonly src: Uint8Array;
	readonly hashMask: number;
	/**
	 * Packed hash table: buckets[i] through buckets[i+1] are the entries
	 * for hash bucket i.
	 */
	readonly buckets: Uint32Array;
	readonly entries: IndexEntry[];
}

export interface DeltaObject {
	type: ObjectType;
	content: Uint8Array;
	hash: ObjectId;
}

interface DeltaSearchOptions {
	window?: number;
	depth?: number;
}

interface DeltaResult {
	hash: ObjectId;
	type: ObjectType;
	content: Uint8Array;
	deltaBase?: ObjectId;
	delta?: Uint8Array;
	depth: number;
}

// ── Index construction ───────────────────────────────────────────────

export function createDeltaIndex(src: Uint8Array): DeltaIndex | null {
	const bufsize = src.byteLength;
	if (bufsize === 0) return null;

	const entries = ((bufsize - 1) / RABIN_WINDOW) | 0;
	if (entries === 0) return null;

	// Hash table size: smallest power of 2 >= entries/4, minimum 16
	let hsize = entries >>> 2;
	if (hsize < 16) hsize = 16;
	hsize = nextPow2(hsize);
	const hmask = hsize - 1;

	// Build entries from end to start (matching git's order)
	const hashCount = new Uint32Array(hsize);
	const rawEntries: IndexEntry[] = [];

	let prevVal = ~0 >>> 0;
	for (let dataOff = entries * RABIN_WINDOW - RABIN_WINDOW; dataOff >= 0; dataOff -= RABIN_WINDOW) {
		let val = 0;
		for (let i = 1; i <= RABIN_WINDOW; i++) {
			val = ((val << 8) | src[dataOff + i]!) ^ T[val >>> RABIN_SHIFT]!;
		}
		val = val >>> 0;

		if (val === prevVal) {
			// Consecutive identical blocks: keep only the lowest offset
			rawEntries[rawEntries.length - 1]!.ptr = dataOff + RABIN_WINDOW;
		} else {
			prevVal = val;
			const bucket = val & hmask;
			rawEntries.push({ ptr: dataOff + RABIN_WINDOW, val });
			hashCount[bucket]!++;
		}
	}

	// Cap buckets at HASH_LIMIT by uniformly culling excess entries
	const bucketAssign = new Map<number, IndexEntry[]>();
	for (const entry of rawEntries) {
		const bucket = entry.val & hmask;
		let list = bucketAssign.get(bucket);
		if (!list) {
			list = [];
			bucketAssign.set(bucket, list);
		}
		list.push(entry);
	}

	for (const [bucket, list] of bucketAssign) {
		if (list.length <= HASH_LIMIT) continue;
		// Uniformly cull to HASH_LIMIT entries
		const keep: IndexEntry[] = [];
		const step = list.length / HASH_LIMIT;
		for (let i = 0; i < HASH_LIMIT; i++) {
			keep.push(list[Math.floor(i * step)]!);
		}
		bucketAssign.set(bucket, keep);
		hashCount[bucket] = HASH_LIMIT;
	}

	// Pack into contiguous arrays with sentinel-based bucket boundaries
	const packedBuckets = new Uint32Array(hsize + 1);
	const packedEntries: IndexEntry[] = [];

	let offset = 0;
	for (let i = 0; i < hsize; i++) {
		packedBuckets[i] = offset;
		const list = bucketAssign.get(i);
		if (list) {
			for (const entry of list) {
				packedEntries.push(entry);
			}
			offset += list.length;
		}
	}
	packedBuckets[hsize] = offset;

	return {
		src,
		hashMask: hmask,
		buckets: packedBuckets,
		entries: packedEntries,
	};
}

// ── Delta creation ───────────────────────────────────────────────────

/**
 * Create a delta that transforms `index.src` into `target`.
 * Returns null if the delta would exceed `maxSize` or if no index.
 */
export function createDelta(
	index: DeltaIndex | null,
	target: Uint8Array,
	maxSize?: number,
): Uint8Array | null {
	if (!index || target.byteLength === 0) return null;

	const srcSize = index.src.byteLength;
	const trgSize = target.byteLength;
	const src = index.src;

	// Output buffer — grows as needed
	let out = new Uint8Array(Math.max(trgSize, 1024));
	let outpos = 0;

	function ensureSpace(needed: number) {
		while (outpos + needed > out.length) {
			const next = new Uint8Array(out.length * 2);
			next.set(out);
			out = next;
		}
	}

	// Header: base-128 encoded source size, then target size
	outpos = encodeSizeAt(out, outpos, srcSize);
	outpos = encodeSizeAt(out, outpos, trgSize);

	// Prime the rolling hash with the first RABIN_WINDOW bytes as insert data.
	// This matches git's approach: initial bytes are always inserted.
	ensureSpace(RABIN_WINDOW + 2);
	outpos++; // reserve space for initial insert count byte
	let val = 0;
	let inscnt = 0;
	const initLen = Math.min(RABIN_WINDOW, trgSize);
	for (let i = 0; i < initLen; i++) {
		out[outpos++] = target[i]!;
		val = ((val << 8) | target[i]!) ^ T[val >>> RABIN_SHIFT]!;
		inscnt++;
	}
	val = val >>> 0;

	let dataPos = initLen;
	let moff = 0;
	let msize = 0;

	while (dataPos < trgSize) {
		// Look for matches only when current match < GOOD_ENOUGH_MATCH
		if (msize < GOOD_ENOUGH_MATCH) {
			// Roll the hash: remove outgoing byte, add incoming byte
			val ^= U[target[dataPos - RABIN_WINDOW]!]!;
			val = (((val << 8) | target[dataPos]!) ^ T[val >>> RABIN_SHIFT]!) >>> 0;

			const bucket = val & index.hashMask;
			const bucketStart = index.buckets[bucket]!;
			const bucketEnd = index.buckets[bucket + 1]!;

			for (let ei = bucketStart; ei < bucketEnd; ei++) {
				const entry = index.entries[ei]!;
				if (entry.val !== val) continue;

				const ref = entry.ptr;
				let refSize = src.byteLength - ref;
				const remaining = trgSize - dataPos;
				if (refSize > remaining) refSize = remaining;
				if (refSize <= msize) break;

				// Extend match forward
				let matchLen = 0;
				while (matchLen < refSize && src[ref + matchLen] === target[dataPos + matchLen]) {
					matchLen++;
				}

				if (matchLen > msize) {
					msize = matchLen;
					moff = ref;
					if (msize >= GOOD_ENOUGH_MATCH) break;
				}
			}
		}

		if (msize < MIN_COPY_SIZE) {
			// No useful match — emit as insert data
			ensureSpace(2);
			if (inscnt === 0) outpos++; // reserve space for count byte
			out[outpos++] = target[dataPos++]!;
			inscnt++;
			if (inscnt === MAX_INSERT_SIZE) {
				out[outpos - inscnt - 1] = inscnt;
				inscnt = 0;
			}
			msize = 0;
		} else {
			// Extend match backward into the current insert run
			if (inscnt > 0) {
				while (moff > 0 && src[moff - 1] === target[dataPos - 1]) {
					msize++;
					moff--;
					dataPos--;
					outpos--;
					if (--inscnt > 0) continue;
					outpos--; // remove count slot
					inscnt = -1;
					break;
				}
				if (inscnt > 0) {
					out[outpos - inscnt - 1] = inscnt;
				}
				inscnt = 0;
			}

			// Emit copy instruction(s) — each copy limited to MAX_COPY_SIZE
			const left = msize > MAX_COPY_SIZE ? msize - MAX_COPY_SIZE : 0;
			msize -= left;

			ensureSpace(8);
			const opPos = outpos++;
			let cmd = 0x80;

			if (moff & 0x000000ff) {
				out[outpos++] = moff & 0xff;
				cmd |= 0x01;
			}
			if (moff & 0x0000ff00) {
				out[outpos++] = (moff >>> 8) & 0xff;
				cmd |= 0x02;
			}
			if (moff & 0x00ff0000) {
				out[outpos++] = (moff >>> 16) & 0xff;
				cmd |= 0x04;
			}
			if (moff & 0xff000000) {
				out[outpos++] = (moff >>> 24) & 0xff;
				cmd |= 0x08;
			}

			if (msize & 0x00ff) {
				out[outpos++] = msize & 0xff;
				cmd |= 0x10;
			}
			if (msize & 0xff00) {
				out[outpos++] = (msize >>> 8) & 0xff;
				cmd |= 0x20;
			}

			out[opPos] = cmd;

			dataPos += msize;
			moff += msize;
			msize = left;

			if (moff > 0xffffffff) msize = 0;

			// Re-prime the rolling hash after a copy
			if (msize < GOOD_ENOUGH_MATCH) {
				val = 0;
				for (let j = -RABIN_WINDOW; j < 0; j++) {
					val = ((val << 8) | target[dataPos + j]!) ^ T[val >>> RABIN_SHIFT]!;
				}
				val = val >>> 0;
			}
		}

		// Check max_size constraint
		if (maxSize && outpos > maxSize) return null;
	}

	// Finalize trailing insert
	if (inscnt > 0) {
		out[outpos - inscnt - 1] = inscnt;
	}

	if (maxSize && outpos > maxSize) return null;

	return out.subarray(0, outpos);
}

// ── Windowed delta search ────────────────────────────────────────────

const TYPE_ORDER: Record<string, number> = {
	blob: 0,
	tree: 1,
	commit: 2,
	tag: 3,
};

/**
 * Find optimal delta bases for a set of objects using a sliding window.
 * Objects are sorted by type then size descending; each object tries
 * the preceding `window` objects as potential bases.
 */
export function findBestDeltas(
	objects: DeltaObject[],
	options?: DeltaSearchOptions,
): DeltaResult[] {
	const window = options?.window ?? 10;
	const maxDepth = options?.depth ?? 50;

	// Sort by type, then size descending (larger objects first as bases)
	const sorted = objects.slice().sort((a, b) => {
		const ta = TYPE_ORDER[a.type] ?? 99;
		const tb = TYPE_ORDER[b.type] ?? 99;
		if (ta !== tb) return ta - tb;
		return b.content.byteLength - a.content.byteLength;
	});

	// Track results by hash for depth lookups
	const resultMap = new Map<ObjectId, DeltaResult>();
	const results: DeltaResult[] = [];

	// Sliding window of recent indices (for reuse)
	const windowIndices: (DeltaIndex | null)[] = [];
	const windowHashes: ObjectId[] = [];

	for (let i = 0; i < sorted.length; i++) {
		const obj = sorted[i]!;
		const result: DeltaResult = {
			hash: obj.hash,
			type: obj.type,
			content: obj.content,
			depth: 0,
		};

		// Try each candidate in the window as a base
		let bestDelta: Uint8Array | null = null;
		let bestBase: ObjectId | null = null;

		const windowStart = Math.max(0, i - window);
		for (let wi = i - 1; wi >= windowStart; wi--) {
			const candidate = sorted[wi]!;
			// Only delta within the same object type
			if (candidate.type !== obj.type) continue;

			// Check depth limit
			const candidateResult = resultMap.get(candidate.hash);
			const candidateDepth = candidateResult?.depth ?? 0;
			if (candidateDepth >= maxDepth) continue;

			// Size heuristic: skip if target is much smaller than base (< 1/32)
			if (obj.content.byteLength < candidate.content.byteLength >>> 5) continue;

			const idx = windowIndices[wi - windowStart] ?? null;
			if (!idx) continue;

			const maxSize = bestDelta ? bestDelta.byteLength : (obj.content.byteLength / 2) | 0;
			if (maxSize < 16) continue;

			const delta = createDelta(idx, obj.content, maxSize);
			if (delta && (!bestDelta || delta.byteLength < bestDelta.byteLength)) {
				bestDelta = delta;
				bestBase = candidate.hash;
			}
		}

		if (bestDelta && bestBase) {
			result.delta = bestDelta;
			result.deltaBase = bestBase;
			const baseResult = resultMap.get(bestBase);
			result.depth = (baseResult?.depth ?? 0) + 1;
		}

		resultMap.set(obj.hash, result);
		results.push(result);

		// Maintain sliding window of indices
		if (windowIndices.length >= window) {
			windowIndices.shift();
			windowHashes.shift();
		}
		windowIndices.push(createDeltaIndex(obj.content));
		windowHashes.push(obj.hash);
	}

	return results;
}

// ── Helpers ──────────────────────────────────────────────────────────

function nextPow2(n: number): number {
	let v = n;
	v--;
	v |= v >> 1;
	v |= v >> 2;
	v |= v >> 4;
	v |= v >> 8;
	v |= v >> 16;
	v++;
	return v < 16 ? 16 : v;
}

function encodeSizeAt(buf: Uint8Array, pos: number, size: number): number {
	let s = size;
	do {
		let byte = s & 0x7f;
		s >>>= 7;
		if (s > 0) byte |= 0x80;
		buf[pos++] = byte;
	} while (s > 0);
	return pos;
}
