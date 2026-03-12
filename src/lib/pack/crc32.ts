// ISO 3309 / ITU-T V.42 CRC32 (polynomial 0xEDB88320), same as zlib/gzip.

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	TABLE[n] = c;
}

export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.byteLength; i++) {
		crc = TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
