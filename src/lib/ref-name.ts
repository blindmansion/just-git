// Ref-name validation and short/long name helpers. A dependency-free leaf:
// pure string logic over ref names, with no other `lib` imports, so a consumer
// that only needs (say) `shortenRef` doesn't transitively load the ref store,
// reflog, or object-db.

const LOCK_SUFFIX = ".lock";

/**
 * Flags for `checkRefFormat`, matching git's `REFNAME_*` constants.
 */
export const enum RefFormatFlag {
	NONE = 0,
	/** Accept one-level ref names (no `/` required). */
	ALLOW_ONELEVEL = 1,
	/** Allow a single `*` wildcard (for refspec patterns). */
	REFSPEC_PATTERN = 2,
}

/**
 * Character disposition table, direct port of git's `refname_disposition[]`.
 *
 *  0 = acceptable
 *  1 = end-of-component (NUL, `/`)
 *  2 = `.` — look for preceding `.` to reject `..`
 *  3 = `{` — look for preceding `@` to reject `@{`
 *  4 = forbidden (controls, space, `:`, `?`, `[`, `\`, `^`, `~`, DEL)
 *  5 = `*` — reject unless REFSPEC_PATTERN
 */
// prettier-ignore
const DISP: readonly number[] = [
	/*  0 NUL */ 1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	/* 10     */ 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	/* 20  SP */ 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 2, 1,  //  !"#$%&'()*+,-./ 
	/* 30   0 */ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 4,  // 0-9 : ; < = > ?
	/* 40   @ */ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // @ A-O
	/* 50   P */ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 0, 4, 0,  // P-Z [ \ ] ^ _
	/* 60   ` */ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // ` a-o
	/* 70   p */ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 4, 4,  // p-z { | } ~ DEL
];

function checkRefNameComponent(
	name: string,
	offset: number,
	allowStar: boolean,
): { len: number; starConsumed: boolean } {
	let last = 0;
	let starConsumed = false;
	let i = offset;
	for (; i < name.length; i++) {
		const ch = name.charCodeAt(i);
		const d = ch < 128 ? DISP[ch]! : 0;
		switch (d) {
			case 1: // end-of-component (NUL or `/`)
				break;
			case 2: // `.`
				if (last === 0x2e) return { len: -1, starConsumed }; // `..`
				last = ch;
				continue;
			case 3: // `{`
				if (last === 0x40) return { len: -1, starConsumed }; // `@{`
				last = ch;
				continue;
			case 4: // forbidden
				return { len: -1, starConsumed };
			case 5: // `*`
				if (!allowStar) return { len: -1, starConsumed };
				starConsumed = true;
				last = ch;
				continue;
			default:
				last = ch;
				continue;
		}
		break; // end-of-component
	}

	const compLen = i - offset;
	if (compLen === 0) return { len: 0, starConsumed };
	if (name.charCodeAt(offset) === 0x2e) return { len: -1, starConsumed }; // starts with `.`
	if (compLen >= LOCK_SUFFIX.length) {
		const tail = name.slice(i - LOCK_SUFFIX.length, i);
		if (tail === LOCK_SUFFIX) return { len: -1, starConsumed };
	}
	return { len: compLen, starConsumed };
}

/**
 * Port of git's `check_refname_format()`. Returns `true` if `refname`
 * is well-formed according to the rules in `git-check-ref-format(1)`.
 */
export function checkRefFormat(
	refname: string,
	flags: RefFormatFlag = RefFormatFlag.NONE,
): boolean {
	if (refname === "@") return false;
	if (refname.length === 0) return false;

	let pos = 0;
	let components = 0;
	let allowStar = !!(flags & RefFormatFlag.REFSPEC_PATTERN);

	while (pos <= refname.length) {
		const { len, starConsumed } = checkRefNameComponent(refname, pos, allowStar);
		if (len < 0) return false;
		if (len === 0) return false; // empty component (leading `/`, `//`, trailing `/`)
		if (starConsumed) allowStar = false;
		components++;
		pos += len + 1; // skip past component + `/`
	}

	if (refname.charCodeAt(refname.length - 1) === 0x2e) return false; // ends with `.`
	if (!(flags & RefFormatFlag.ALLOW_ONELEVEL) && components < 2) return false;
	return true;
}

/**
 * Validate a branch name (short form, e.g. "main"). Rejects names that
 * would produce an invalid full ref under `refs/heads/`.
 */
export function isValidBranchName(name: string): boolean {
	if (!name) return false;
	if (name.startsWith("-")) return false;
	return checkRefFormat(`refs/heads/${name}`, RefFormatFlag.NONE);
}

/**
 * Validate a tag name (short form). Rejects names that would produce
 * an invalid full ref under `refs/tags/`.
 */
export function isValidTagName(name: string): boolean {
	if (!name) return false;
	return checkRefFormat(`refs/tags/${name}`, RefFormatFlag.NONE);
}

/** Extract the short branch name from a full ref path like "refs/heads/main" → "main". */
export function branchNameFromRef(ref: string): string {
	return ref.replace("refs/heads/", "");
}

/** Extract the short tag name from a full ref path like "refs/tags/v1.0" → "v1.0". */
export function tagNameFromRef(ref: string): string {
	return ref.replace("refs/tags/", "");
}

/** Strip the longest matching standard ref prefix (heads, tags, remotes). */
export function shortenRef(ref: string): string {
	if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
	if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
	if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
	return ref;
}
