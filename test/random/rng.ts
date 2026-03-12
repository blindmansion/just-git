/**
 * Seeded pseudorandom number generator using xorshift128+.
 *
 * Deterministic: the same seed always produces the same sequence.
 * Fast, good enough distribution for test generation.
 */
export class SeededRNG {
	private s0: bigint;
	private s1: bigint;

	constructor(public readonly seed: number) {
		// Initialize state from seed using splitmix64
		let s = BigInt(seed) & 0xffffffffffffffffn;
		s = ((s ^ (s >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
		this.s0 = s;
		s = ((s ^ (s >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
		this.s1 = s;
		// Ensure non-zero state
		if (this.s0 === 0n && this.s1 === 0n) {
			this.s0 = 1n;
		}
	}

	/** Generate next raw 64-bit value. */
	private nextRaw(): bigint {
		let s1 = this.s0;
		const s0 = this.s1;
		const result = (s0 + s1) & 0xffffffffffffffffn;
		this.s0 = s0;
		s1 ^= (s1 << 23n) & 0xffffffffffffffffn;
		this.s1 = (s1 ^ s0 ^ (s1 >> 17n) ^ (s0 >> 26n)) & 0xffffffffffffffffn;
		return result;
	}

	/** Returns a float in [0, 1). */
	next(): number {
		const raw = this.nextRaw();
		// Use upper 53 bits for a double in [0, 1)
		return Number((raw >> 11n) & 0x1fffffffffffffn) / 2 ** 53;
	}

	/** Returns an integer in [min, max] (inclusive). */
	int(min: number, max: number): number {
		return Math.floor(this.next() * (max - min + 1)) + min;
	}

	/** Pick a random element from an array. Throws if empty. */
	pick<T>(arr: readonly T[]): T {
		if (arr.length === 0) throw new Error("Cannot pick from empty array");
		return arr[this.int(0, arr.length - 1)];
	}

	/** Pick a random element using weights. Higher weight = more likely. */
	pickWeighted<T>(items: readonly { value: T; weight: number }[]): T {
		const total = items.reduce((sum, item) => sum + item.weight, 0);
		if (total <= 0) throw new Error("Total weight must be positive");
		let threshold = this.next() * total;
		for (const item of items) {
			threshold -= item.weight;
			if (threshold <= 0) return item.value;
		}
		// Floating-point edge case: return last item
		return items[items.length - 1].value;
	}

	/** Generate a random alphanumeric string of the given length. */
	alphanumeric(length: number): string {
		const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
		let result = "";
		for (let i = 0; i < length; i++) {
			result += chars[this.int(0, chars.length - 1)];
		}
		return result;
	}

	/** Generate a random boolean with the given probability of true. */
	bool(probability = 0.5): boolean {
		return this.next() < probability;
	}
}
