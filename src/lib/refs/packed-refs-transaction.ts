import type { DurableFileSystem } from "../../fs/index.ts";
import { readPackedRefs, walkLooseRefs } from "../file-ref-database.ts";
import type { ObjectId } from "../types.ts";
import { isPerWorktreeRef } from "./classify.ts";
import { checkRefFormat } from "./name.ts";
import { createNativeRefMutation, type NativePackedRefPruneCandidate } from "./native-mutation.ts";

const OBJECT_ID = /^[0-9a-f]{40}$/;

export interface PackedRefsTransactionOptions {
	gitDir: string;
	commonDir: string;
	peelTag?: (hash: ObjectId) => Promise<ObjectId | null>;
}

/**
 * Pack shared loose refs using Git's packed-refs lock and conditional-prune
 * protocol.
 */
export async function writePackedRefsNative(
	fs: DurableFileSystem,
	options: PackedRefsTransactionOptions,
): Promise<void> {
	const mutation = createNativeRefMutation(fs, {
		gitDir: options.gitDir,
		commonDir: options.commonDir,
	});

	await mutation.packRefs(async () => {
		const refs = await readPackedRefs(fs, options.commonDir);
		const pruneCandidates: NativePackedRefPruneCandidate[] = [];

		for (const loose of await walkLooseRefs(fs, options.commonDir, "refs")) {
			if (isPerWorktreeRef(loose.name) || !checkRefFormat(loose.name)) continue;
			if (loose.ref.type === "symbolic") {
				// A loose symbolic ref takes precedence and must never be
				// materialized as a direct packed ref.
				refs.delete(loose.name);
				continue;
			}
			if (!OBJECT_ID.test(loose.ref.hash)) continue;
			refs.set(loose.name, loose.ref.hash);
			pruneCandidates.push({ name: loose.name, ref: loose.ref });
		}

		if (refs.size === 0) return null;

		const lines = ["# pack-refs with: peeled fully-peeled sorted"];
		for (const [name, hash] of [...refs].sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		)) {
			lines.push(`${hash} ${name}`);
			if (name.startsWith("refs/tags/") && options.peelTag) {
				const peeled = await options.peelTag(hash);
				if (peeled) lines.push(`^${peeled}`);
			}
		}

		return {
			content: `${lines.join("\n")}\n`,
			pruneCandidates,
		};
	});
}
