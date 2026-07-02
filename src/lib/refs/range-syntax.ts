type RangeSyntax =
	| { type: "two-dot"; left: string; right: string }
	| { type: "three-dot"; left: string; right: string };

export function parseRangeSyntax(arg: string): RangeSyntax | null {
	const threeIdx = arg.indexOf("...");
	if (threeIdx >= 0) {
		return {
			type: "three-dot",
			left: arg.slice(0, threeIdx) || "HEAD",
			right: arg.slice(threeIdx + 3) || "HEAD",
		};
	}
	const twoIdx = arg.indexOf("..");
	if (twoIdx >= 0) {
		return {
			type: "two-dot",
			left: arg.slice(0, twoIdx) || "HEAD",
			right: arg.slice(twoIdx + 2) || "HEAD",
		};
	}
	return null;
}
