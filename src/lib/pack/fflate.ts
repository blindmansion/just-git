// oxlint-disable no-unused-expressions
// @ts-nocheck — vendored code; strict indexing checks are false positives
//
// Vendored from fflate v0.8.2 (https://github.com/101arrowz/fflate)
// MIT License — Copyright (c) 2023 Arjun Barrett
//
// Both synchronous inflate (decompression) and deflate (compression)
// paths are included, sharing the bulk of their lookup tables/helpers.
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

const { b: fl, r: revfl } = freb(fleb, 2);
fl[28] = 258;
revfl[258] = 28;
const { b: fd, r: revfd } = freb(fdeb, 0);

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
// fixed length/distance maps (non-reversed) — used by the deflate path
const flm = hMap(flt, 9, 0);
const fdm = hMap(fdt, 5, 0);

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
 *
 * NOTE: like fflate (and unlike `node:zlib`), the adler32 trailer is NOT
 * verified — the 4 checksum bytes are stripped and ignored. Integrity of
 * decompressed git objects is enforced downstream by their SHA-1 (a
 * corrupted body produces a different hash and is rejected at the object
 * store / pack layer), so the checksum check is redundant cost here.
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
 * The adler32 is not verified (see {@link pureInflate}).
 *
 * When `expectedSize` is supplied, a pre-sized output buffer is handed to
 * inflt so it never grows its allocation past the declared size — fflate's
 * built-in defense against a malformed/hostile stream inflating far beyond
 * what its object header claims. One extra sentinel byte is allocated so
 * over-production is observable: a stream that expands past `expectedSize`
 * fills the sentinel, making the result length differ from `expectedSize`
 * (callers reject on the mismatch) rather than being silently truncated.
 */
export function pureInflateWithConsumed(
	data: Uint8Array,
	expectedSize?: number,
): {
	result: Uint8Array;
	bytesConsumed: number;
} {
	const hdrLen = zls(data);
	const st: InflateState = { i: 2 };
	const out = expectedSize == null ? undefined : new u8(expectedSize + 1);
	const result = inflt(data.subarray(hdrLen), st, out);
	// st.p is the bit position where the final DEFLATE block ended. shft()
	// rounds up to whole bytes; +4 accounts for the trailing adler32. When
	// st.p is undefined the input held only the header (no block parsed).
	const deflateBytes = st.p == null ? 0 : shft(st.p);
	const bytesConsumed = hdrLen + deflateBytes + 4;
	// Guard against truncated input: if the computed end runs past the
	// buffer, the adler32 trailer isn't fully present yet. Native zlib
	// throws here too; throwing lets streaming callers pull more bytes
	// rather than silently over-reporting bytesConsumed (which desyncs a
	// back-to-back entry walk).
	if (bytesConsumed > data.length) throwError(0);
	return { result, bytesConsumed };
}

// ── Deflate (compression) ────────────────────────────────────────────
// Reuses the tables/helpers above (u8/u16/i32, fleb, fdeb, clim, freb,
// rev, hMap, flt, fdt, flm, fdm, revfl, revfd, max, bits, shft, slc).

// starting at p, write the minimum number of bits that can hold v to d
const wbits = (d: Uint8Array, p: number, v: number) => {
	v <<= p & 7;
	const o = (p / 8) | 0;
	d[o] |= v;
	d[o + 1] |= v >> 8;
};

// starting at p, write the minimum number of bits (>8) that can hold v to d
const wbits16 = (d: Uint8Array, p: number, v: number) => {
	v <<= p & 7;
	const o = (p / 8) | 0;
	d[o] |= v;
	d[o + 1] |= v >> 8;
	d[o + 2] |= v >> 16;
};

type HuffNode = {
	s: number; // symbol
	f: number; // frequency
	l?: HuffNode; // left child
	r?: HuffNode; // right child
};

// creates code lengths from a frequency table
const hTree = (d: Uint16Array, mb: number) => {
	const t: HuffNode[] = [];
	for (let i = 0; i < d.length; ++i) {
		if (d[i]) t.push({ s: i, f: d[i] });
	}
	const s = t.length;
	const t2 = t.slice();
	if (!s) return { t: et, l: 0 };
	if (s == 1) {
		const v = new u8(t[0].s + 1);
		v[t[0].s] = 1;
		return { t: v, l: 1 };
	}
	t.sort((a, b) => a.f - b.f);
	t.push({ s: -1, f: 25001 });
	let l = t[0],
		r = t[1],
		i0 = 0,
		i1 = 1,
		i2 = 2;
	t[0] = { s: -1, f: l.f + r.f, l, r };
	while (i1 != s - 1) {
		l = t[t[i0].f < t[i2].f ? i0++ : i2++];
		r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
		t[i1++] = { s: -1, f: l.f + r.f, l, r };
	}
	let maxSym = t2[0].s;
	for (let i = 1; i < s; ++i) {
		if (t2[i].s > maxSym) maxSym = t2[i].s;
	}
	const tr = new u16(maxSym + 1);
	let mbt = ln(t[i1 - 1], tr, 0);
	if (mbt > mb) {
		let i = 0,
			dt = 0;
		const lft = mbt - mb,
			cst = 1 << lft;
		t2.sort((a, b) => tr[b.s] - tr[a.s] || a.f - b.f);
		for (; i < s; ++i) {
			const i2 = t2[i].s;
			if (tr[i2] > mb) {
				dt += cst - (1 << (mbt - tr[i2]));
				tr[i2] = mb;
			} else break;
		}
		dt >>= lft;
		while (dt > 0) {
			const i2 = t2[i].s;
			if (tr[i2] < mb) dt -= 1 << (mb - tr[i2]++ - 1);
			else ++i;
		}
		for (; i >= 0 && dt; --i) {
			const i2 = t2[i].s;
			if (tr[i2] == mb) {
				--tr[i2];
				++dt;
			}
		}
		mbt = mb;
	}
	return { t: new u8(tr), l: mbt };
};

// get the max length and assign length codes
const ln = (n: HuffNode, l: Uint16Array, d: number): number => {
	return n.s == -1 ? Math.max(ln(n.l!, l, d + 1), ln(n.r!, l, d + 1)) : (l[n.s] = d);
};

// length codes generation
const lc = (c: Uint8Array) => {
	let s = c.length;
	while (s && !c[--s]);
	const cl = new u16(++s);
	let cli = 0,
		cln = c[0],
		cls = 1;
	const w = (v: number) => {
		cl[cli++] = v;
	};
	for (let i = 1; i <= s; ++i) {
		if (c[i] == cln && i != s) ++cls;
		else {
			if (!cln && cls > 2) {
				for (; cls > 138; cls -= 138) w(32754);
				if (cls > 2) {
					w(cls > 10 ? ((cls - 11) << 5) | 28690 : ((cls - 3) << 5) | 12305);
					cls = 0;
				}
			} else if (cls > 3) {
				w(cln), --cls;
				for (; cls > 6; cls -= 6) w(8304);
				if (cls > 2) w(((cls - 3) << 5) | 8208), (cls = 0);
			}
			while (cls--) w(cln);
			cls = 1;
			cln = c[i];
		}
	}
	return { c: cl.subarray(0, cli), n: s };
};

// calculate the length of output from tree, code lengths
const clen = (cf: Uint16Array, cl: Uint8Array) => {
	let l = 0;
	for (let i = 0; i < cl.length; ++i) l += cf[i] * cl[i];
	return l;
};

// writes a fixed block — returns the new bit pos
const wfblk = (out: Uint8Array, pos: number, dat: Uint8Array) => {
	const s = dat.length;
	const o = shft(pos + 2);
	out[o] = s & 255;
	out[o + 1] = s >> 8;
	out[o + 2] = out[o] ^ 255;
	out[o + 3] = out[o + 1] ^ 255;
	for (let i = 0; i < s; ++i) out[o + i + 4] = dat[i];
	return (o + 4 + s) * 8;
};

// writes a block
const wblk = (
	dat: Uint8Array,
	out: Uint8Array,
	final: number,
	syms: Int32Array,
	lf: Uint16Array,
	df: Uint16Array,
	eb: number,
	li: number,
	bs: number,
	bl: number,
	p: number,
) => {
	wbits(out, p++, final);
	++lf[256];
	const { t: dlt, l: mlb } = hTree(lf, 15);
	const { t: ddt, l: mdb } = hTree(df, 15);
	const { c: lclt, n: nlc } = lc(dlt);
	const { c: lcdt, n: ndc } = lc(ddt);
	const lcfreq = new u16(19);
	for (let i = 0; i < lclt.length; ++i) ++lcfreq[lclt[i] & 31];
	for (let i = 0; i < lcdt.length; ++i) ++lcfreq[lcdt[i] & 31];
	const { t: lct, l: mlcb } = hTree(lcfreq, 7);
	let nlcc = 19;
	for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc);
	const flen = (bl + 5) << 3;
	const ftlen = clen(lf, flt) + clen(df, fdt) + eb;
	const dtlen =
		clen(lf, dlt) +
		clen(df, ddt) +
		eb +
		14 +
		3 * nlcc +
		clen(lcfreq, lct) +
		2 * lcfreq[16] +
		3 * lcfreq[17] +
		7 * lcfreq[18];
	if (bs >= 0 && flen <= ftlen && flen <= dtlen) return wfblk(out, p, dat.subarray(bs, bs + bl));
	let lm: Uint16Array, ll: Uint8Array, dm: Uint16Array, dl: Uint8Array;
	wbits(out, p, 1 + ((dtlen < ftlen) as unknown as number)), (p += 2);
	if (dtlen < ftlen) {
		(lm = hMap(dlt, mlb, 0)), (ll = dlt), (dm = hMap(ddt, mdb, 0)), (dl = ddt);
		const llm = hMap(lct, mlcb, 0);
		wbits(out, p, nlc - 257);
		wbits(out, p + 5, ndc - 1);
		wbits(out, p + 10, nlcc - 4);
		p += 14;
		for (let i = 0; i < nlcc; ++i) wbits(out, p + 3 * i, lct[clim[i]]);
		p += 3 * nlcc;
		const lcts = [lclt, lcdt];
		for (let it = 0; it < 2; ++it) {
			const clct = lcts[it];
			for (let i = 0; i < clct.length; ++i) {
				const len = clct[i] & 31;
				(wbits(out, p, llm[len]), (p += lct[len]));
				if (len > 15) (wbits(out, p, (clct[i] >> 5) & 127), (p += clct[i] >> 12));
			}
		}
	} else {
		(lm = flm), (ll = flt), (dm = fdm), (dl = fdt);
	}
	for (let i = 0; i < li; ++i) {
		const sym = syms[i];
		if (sym > 255) {
			const len = (sym >> 18) & 31;
			(wbits16(out, p, lm[len + 257]), (p += ll[len + 257]));
			if (len > 7) (wbits(out, p, (sym >> 23) & 31), (p += fleb[len]));
			const dst = sym & 31;
			(wbits16(out, p, dm[dst]), (p += dl[dst]));
			if (dst > 3) (wbits16(out, p, (sym >> 5) & 8191), (p += fdeb[dst]));
		} else {
			(wbits16(out, p, lm[sym]), (p += ll[sym]));
		}
	}
	wbits16(out, p, lm[256]);
	return p + ll[256];
};

// deflate options (nice << 13) | chain
const deo = new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);

// empty
const et = new u8(0);

type DeflateState = {
	h?: Uint16Array; // head
	p?: Uint16Array; // prev
	i?: number; // index
	z?: number; // end index
	w?: number; // wait index
	r?: number; // remainder byte info
	l: number; // last chunk
};

// compresses data into a raw DEFLATE buffer
const dflt = (
	dat: Uint8Array,
	lvl: number,
	plvl: number,
	pre: number,
	post: number,
	st: DeflateState,
) => {
	const s = st.z || dat.length;
	const o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7000)) + post);
	const w = o.subarray(pre, o.length - post);
	const lst = st.l;
	let pos = (st.r || 0) & 7;
	if (lvl) {
		if (pos) w[0] = st.r! >> 3;
		const opt = deo[lvl - 1];
		const n = opt >> 13,
			c = opt & 8191;
		const msk = (1 << plvl) - 1;
		const prev = st.p || new u16(32768),
			head = st.h || new u16(msk + 1);
		const bs1 = Math.ceil(plvl / 3),
			bs2 = 2 * bs1;
		const hsh = (i: number) => (dat[i] ^ (dat[i + 1] << bs1) ^ (dat[i + 2] << bs2)) & msk;
		const syms = new i32(25000);
		const lf = new u16(288),
			df = new u16(32);
		let lc = 0,
			eb = 0,
			i = st.i || 0,
			li = 0,
			wi = st.w || 0,
			bs = 0;
		for (; i + 2 < s; ++i) {
			const hv = hsh(i);
			let imod = i & 32767,
				pimod = head[hv];
			prev[imod] = pimod;
			head[hv] = imod;
			if (wi <= i) {
				const rem = s - i;
				if ((lc > 7000 || li > 24576) && (rem > 423 || !lst)) {
					pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
					(li = lc = eb = 0), (bs = i);
					for (let j = 0; j < 286; ++j) lf[j] = 0;
					for (let j = 0; j < 30; ++j) df[j] = 0;
				}
				let l = 2,
					d = 0,
					ch = c,
					dif = (imod - pimod) & 32767;
				if (rem > 2 && hv == hsh(i - dif)) {
					const maxn = Math.min(n, rem) - 1;
					const maxd = Math.min(32767, i);
					const ml = Math.min(258, rem);
					while (dif <= maxd && --ch && imod != pimod) {
						if (dat[i + l] == dat[i + l - dif]) {
							let nl = 0;
							for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl);
							if (nl > l) {
								(l = nl), (d = dif);
								if (nl > maxn) break;
								const mmd = Math.min(dif, nl - 2);
								let md = 0;
								for (let j = 0; j < mmd; ++j) {
									const ti = (i - dif + j) & 32767;
									const pti = prev[ti];
									const cd = (ti - pti) & 32767;
									if (cd > md) (md = cd), (pimod = ti);
								}
							}
						}
						(imod = pimod), (pimod = prev[imod]);
						dif += (imod - pimod) & 32767;
					}
				}
				if (d) {
					syms[li++] = 268435456 | (revfl[l] << 18) | revfd[d];
					const lin = revfl[l] & 31,
						din = revfd[d] & 31;
					eb += fleb[lin] + fdeb[din];
					++lf[257 + lin];
					++df[din];
					wi = i + l;
					++lc;
				} else {
					syms[li++] = dat[i];
					++lf[dat[i]];
				}
			}
		}
		for (i = Math.max(i, wi); i < s; ++i) {
			syms[li++] = dat[i];
			++lf[dat[i]];
		}
		pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
		if (!lst) {
			st.r = (pos & 7) | (w[(pos / 8) | 0] << 3);
			pos -= 7;
			(st.h = head), (st.p = prev), (st.i = i), (st.w = wi);
		}
	} else {
		for (let i = st.w || 0; i < s + lst; i += 65535) {
			let e = i + 65535;
			if (e >= s) {
				w[(pos / 8) | 0] = lst;
				e = s;
			}
			pos = wfblk(w, pos + 1, dat.subarray(i, e));
		}
		st.i = s;
	}
	return slc(o, 0, pre + shft(pos) + post);
};

// Adler32 checksum
const adler = () => {
	let a = 1,
		b = 0;
	return {
		p(d: Uint8Array) {
			let n = a,
				m = b;
			const l = d.length | 0;
			for (let i = 0; i != l; ) {
				const e = Math.min(i + 2655, l);
				for (; i < e; ++i) m += n += d[i];
				(n = (n & 65535) + 15 * (n >> 16)), (m = (m & 65535) + 15 * (m >> 16));
			}
			(a = n), (b = m);
		},
		d() {
			(a %= 65521), (b %= 65521);
			return (((a & 255) << 24) | ((a & 0xff00) << 8) | ((b & 255) << 8) | (b >> 8)) >>> 0;
		},
	};
};

// deflate with options
const dopt = (dat: Uint8Array, lvl: number, pre: number, post: number) => {
	const st: DeflateState = { l: 1 };
	const mem = st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20;
	return dflt(dat, lvl, mem, pre, post, st);
};

// write a number to a buffer little-endian
const wbytes = (d: Uint8Array, b: number, v: number) => {
	for (; v; ++b) (d[b] = v), (v >>>= 8);
};

// zlib header
const zlh = (c: Uint8Array, lvl: number) => {
	const fl = lvl == 0 ? 0 : lvl < 6 ? 1 : lvl == 9 ? 3 : 2;
	(c[0] = 120), (c[1] = fl << 6);
	c[1] |= 31 - ((((c[0] << 8) | c[1]) % 31) | 0);
};

/**
 * Deflate raw bytes into a zlib-compressed buffer (RFC 1950), matching
 * `node:zlib.deflateSync` / `CompressionStream("deflate")` output format.
 * Pure JS — the final fallback when no platform zlib/CompressionStream
 * is available.
 */
export function pureDeflate(data: Uint8Array, level = 6): Uint8Array {
	const a = adler();
	a.p(data);
	const d = dopt(data, level, 2, 4);
	zlh(d, level);
	wbytes(d, d.length - 4, a.d());
	return d;
}
