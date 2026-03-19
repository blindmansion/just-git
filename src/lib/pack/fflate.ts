// oxlint-disable no-unused-expressions
// @ts-nocheck — vendored code; strict indexing checks are false positives
//
// Vendored from fflate v0.8.2 (https://github.com/101arrowz/fflate)
// MIT License — Copyright (c) 2023 Arjun Barrett
//
// Only the synchronous inflate (decompression) path is included.
// Variable names are kept from the original for traceability.
// https://tools.ietf.org/html/rfc1950 (zlib)
// https://tools.ietf.org/html/rfc1951 (DEFLATE)

const u8 = Uint8Array,
	u16 = Uint16Array,
	i32 = Int32Array;

// fixed length extra bits
const fleb = new u8([
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0,
]);

// fixed distance extra bits
const fdeb = new u8([
	0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
	0, 0,
]);

// code length index map
const clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

const freb = (eb: Uint8Array, start: number) => {
	const b = new u16(31);
	for (let i = 0; i < 31; ++i) {
		b[i] = start += 1 << eb[i - 1];
	}
	const r = new i32(b[30]);
	for (let i = 1; i < 30; ++i) {
		for (let j = b[i]; j < b[i + 1]; ++j) {
			r[j] = ((j - b[i]) << 5) | i;
		}
	}
	return { b, r };
};

const { b: fl } = freb(fleb, 2);
fl[28] = 258;
const { b: fd } = freb(fdeb, 0);

// map of value to reverse (assuming 16 bits)
const rev = new u16(32768);
for (let i = 0; i < 32768; ++i) {
	let x = ((i & 0xaaaa) >> 1) | ((i & 0x5555) << 1);
	x = ((x & 0xcccc) >> 2) | ((x & 0x3333) << 2);
	x = ((x & 0xf0f0) >> 4) | ((x & 0x0f0f) << 4);
	rev[i] = (((x & 0xff00) >> 8) | ((x & 0x00ff) << 8)) >> 1;
}

// create huffman tree from u8 "map": index -> code length for code index
const hMap = (cd: Uint8Array, mb: number, r: 0 | 1) => {
	const s = cd.length;
	let i = 0;
	const l = new u16(mb);
	for (; i < s; ++i) {
		if (cd[i]) ++l[cd[i] - 1];
	}
	const le = new u16(mb);
	for (i = 1; i < mb; ++i) {
		le[i] = (le[i - 1] + l[i - 1]) << 1;
	}
	let co: Uint16Array;
	if (r) {
		co = new u16(1 << mb);
		const rvb = 15 - mb;
		for (i = 0; i < s; ++i) {
			if (cd[i]) {
				const sv = (i << 4) | cd[i];
				const r = mb - cd[i];
				let v = le[cd[i] - 1]++ << r;
				for (const m = v | ((1 << r) - 1); v <= m; ++v) {
					co[rev[v] >> rvb] = sv;
				}
			}
		}
	} else {
		co = new u16(s);
		for (i = 0; i < s; ++i) {
			if (cd[i]) {
				co[i] = rev[le[cd[i] - 1]++] >> (15 - cd[i]);
			}
		}
	}
	return co;
};

// fixed length tree
const flt = new u8(288);
for (let i = 0; i < 144; ++i) flt[i] = 8;
for (let i = 144; i < 256; ++i) flt[i] = 9;
for (let i = 256; i < 280; ++i) flt[i] = 7;
for (let i = 280; i < 288; ++i) flt[i] = 8;
// fixed distance tree
const fdt = new u8(32);
for (let i = 0; i < 32; ++i) fdt[i] = 5;

const flrm = hMap(flt, 9, 1);
const fdrm = hMap(fdt, 5, 1);

const max = (a: Uint8Array | number[]) => {
	let m = a[0];
	for (let i = 1; i < a.length; ++i) {
		if (a[i] > m) m = a[i];
	}
	return m;
};

const bits = (d: Uint8Array, p: number, m: number) => {
	const o = (p / 8) | 0;
	return ((d[o] | (d[o + 1] << 8)) >> (p & 7)) & m;
};

const bits16 = (d: Uint8Array, p: number) => {
	const o = (p / 8) | 0;
	return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) >> (p & 7);
};

const shft = (p: number) => ((p + 7) / 8) | 0;

const slc = (v: Uint8Array, s: number, e?: number) => {
	if (s == null || s < 0) s = 0;
	if (e == null || e > v.length) e = v.length;
	return new u8(v.subarray(s, e));
};

const throwError = (ind: number, msg?: string) => {
	const messages = [
		"unexpected EOF",
		"invalid block type",
		"invalid length/literal",
		"invalid distance",
	];
	throw new Error(msg || messages[ind] || "unknown inflate error");
};

type InflateState = {
	l?: Uint16Array;
	d?: Uint16Array;
	m?: number;
	n?: number;
	f?: number;
	p?: number;
	b?: number;
	i: number;
};

// expands raw DEFLATE data
const inflt = (dat: Uint8Array, st: InflateState, buf?: Uint8Array, dict?: Uint8Array) => {
	const sl = dat.length,
		dl = dict ? dict.length : 0;
	if (!sl || (st.f && !st.l)) return buf || new u8(0);
	const noBuf = !buf;
	const resize = noBuf || st.i != 2;
	const noSt = st.i;
	if (noBuf) buf = new u8(sl * 3);
	const cbuf = (l: number) => {
		let bl = buf!.length;
		if (l > bl) {
			const nbuf = new u8(Math.max(bl * 2, l));
			nbuf.set(buf!);
			buf = nbuf;
		}
	};
	let final = st.f || 0,
		pos = st.p || 0,
		bt = st.b || 0,
		lm = st.l,
		dm = st.d,
		lbt = st.m,
		dbt = st.n;
	const tbts = sl * 8;
	do {
		if (!lm) {
			final = bits(dat, pos, 1);
			const type = bits(dat, pos + 1, 3);
			pos += 3;
			if (!type) {
				const s = shft(pos) + 4,
					l = dat[s - 4] | (dat[s - 3] << 8),
					t = s + l;
				if (t > sl) {
					if (noSt) throwError(0);
					break;
				}
				if (resize) cbuf(bt + l);
				buf!.set(dat.subarray(s, t), bt);
				((st.b = bt += l), (st.p = pos = t * 8), (st.f = final));
				continue;
			} else if (type == 1) ((lm = flrm), (dm = fdrm), (lbt = 9), (dbt = 5));
			else if (type == 2) {
				const hLit = bits(dat, pos, 31) + 257,
					hcLen = bits(dat, pos + 10, 15) + 4;
				const tl = hLit + bits(dat, pos + 5, 31) + 1;
				pos += 14;
				const ldt = new u8(tl);
				const clt = new u8(19);
				for (let i = 0; i < hcLen; ++i) {
					clt[clim[i]] = bits(dat, pos + i * 3, 7);
				}
				pos += hcLen * 3;
				const clb = max(clt),
					clbmsk = (1 << clb) - 1;
				const clm = hMap(clt, clb, 1);
				for (let i = 0; i < tl; ) {
					const r = clm[bits(dat, pos, clbmsk)];
					pos += r & 15;
					const s = r >> 4;
					if (s < 16) {
						ldt[i++] = s;
					} else {
						let c = 0,
							n = 0;
						if (s == 16) ((n = 3 + bits(dat, pos, 3)), (pos += 2), (c = ldt[i - 1]));
						else if (s == 17) ((n = 3 + bits(dat, pos, 7)), (pos += 3));
						else if (s == 18) ((n = 11 + bits(dat, pos, 127)), (pos += 7));
						while (n--) ldt[i++] = c;
					}
				}
				const lt = ldt.subarray(0, hLit),
					dt = ldt.subarray(hLit);
				lbt = max(lt);
				dbt = max(dt);
				lm = hMap(lt, lbt, 1);
				dm = hMap(dt, dbt, 1);
			} else throwError(1);
			if (pos > tbts) {
				if (noSt) throwError(0);
				break;
			}
		}
		if (resize) cbuf(bt + 131072);
		const lms = (1 << lbt!) - 1,
			dms = (1 << dbt!) - 1;
		let lpos = pos;
		for (; ; lpos = pos) {
			const c = lm![bits16(dat, pos) & lms],
				sym = c >> 4;
			pos += c & 15;
			if (pos > tbts) {
				if (noSt) throwError(0);
				break;
			}
			if (!c) throwError(2);
			if (sym < 256) buf![bt++] = sym;
			else if (sym == 256) {
				((lpos = pos), (lm = null!));
				break;
			} else {
				let add = sym - 254;
				if (sym > 264) {
					const i = sym - 257,
						b = fleb[i];
					add = bits(dat, pos, (1 << b) - 1) + fl[i];
					pos += b;
				}
				const d = dm![bits16(dat, pos) & dms],
					dsym = d >> 4;
				if (!d) throwError(3);
				pos += d & 15;
				let dt = fd[dsym];
				if (dsym > 3) {
					const b = fdeb[dsym];
					((dt += bits16(dat, pos) & ((1 << b) - 1)), (pos += b));
				}
				if (pos > tbts) {
					if (noSt) throwError(0);
					break;
				}
				if (resize) cbuf(bt + 131072);
				const end = bt + add;
				if (bt < dt) {
					const shift = dl - dt,
						dend = Math.min(dt, end);
					if (shift + bt < 0) throwError(3);
					for (; bt < dend; ++bt) buf![bt] = dict![shift + bt];
				}
				for (; bt < end; ++bt) buf![bt] = buf![bt - dt];
			}
		}
		((st.l = lm!), (st.p = lpos), (st.b = bt), (st.f = final));
		if (lm) ((final = 1), (st.m = lbt), (st.d = dm!), (st.n = dbt));
	} while (!final);
	return bt != buf!.length && noBuf ? slc(buf!, 0, bt) : buf!.subarray(0, bt);
};

// parse zlib header, return header length in bytes
const zls = (d: Uint8Array) => {
	if ((d[0] & 15) != 8 || d[0] >> 4 > 7 || ((d[0] << 8) | d[1]) % 31)
		throwError(0, "invalid zlib data");
	if (d[1] & 32) throwError(0, "zlib dictionaries are not supported");
	return 2;
};

/**
 * Inflate zlib-compressed data (RFC 1950).
 */
export function pureInflate(data: Uint8Array): Uint8Array {
	const hdrLen = zls(data);
	return inflt(data.subarray(hdrLen, -4), { i: 2 });
}

/**
 * Inflate a single zlib-compressed stream from a buffer that may contain
 * trailing data (back-to-back entries in a packfile). Returns the
 * decompressed bytes and the exact number of compressed bytes consumed.
 *
 * After inflt() finishes, state.p holds the bit position where the last
 * DEFLATE block ended. The zlib envelope adds a fixed header (2 bytes)
 * before and an adler32 checksum (4 bytes) after the raw DEFLATE stream.
 */
export function pureInflateWithConsumed(data: Uint8Array): {
	result: Uint8Array;
	bytesConsumed: number;
} {
	const hdrLen = zls(data);
	const st: InflateState = { i: 2 };
	const result = inflt(data.subarray(hdrLen), st);
	const deflateBytes = shft(st.p!);
	return { result, bytesConsumed: hdrLen + deflateBytes + 4 };
}
