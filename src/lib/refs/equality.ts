import type { Ref } from "../types.ts";

/** Compare exact unresolved ref values by type and payload. */
export function rawRefsEqual(left: Ref | null, right: Ref | null): boolean {
	if (left === null || right === null) return left === right;
	if (left.type !== right.type) return false;
	if (left.type === "direct" && right.type === "direct") {
		return left.hash === right.hash;
	}
	if (left.type === "symbolic" && right.type === "symbolic") {
		return left.target === right.target;
	}
	return false;
}
