import { parseConfig, readConfig, setConfigValueRaw } from "./config.ts";
import { join } from "./path.ts";
import type { GitContext } from "./types.ts";

export function validateObjectFilter(filter: string): "blob:none" {
	if (filter !== "blob:none") throw new Error("Only the blob:none object filter is supported");
	return filter;
}

/** Persist the promise that deliberately omitted objects remain on this remote. */
export async function configurePartialClone(ctx: GitContext, remote: string, filter: "blob:none") {
	const path = join(ctx.commonDir, "config");
	let raw = await ctx.fs.readFile(path);
	const config = parseConfig(raw);
	const remoteSection = `remote "${remote}"`;
	const section = config[remoteSection];
	if (!section?.url) throw new Error("Filtered fetch requires a configured remote");
	if (
		section.promisor === "true" &&
		section.partialclonefilter === filter &&
		config.extensions?.partialclone === remote
	)
		return;
	for (const [section, key, value] of [
		[remoteSection, "promisor", "true"],
		[remoteSection, "partialclonefilter", filter],
		["core", "repositoryformatversion", "1"],
		["extensions", "partialclone", remote],
	] as const)
		raw = setConfigValueRaw(raw, section, key, value);
	await ctx.fs.writeFile(path, raw);
}

/** Maintenance must not mistake promised-but-absent objects for corruption. */
export async function requireCompleteRepository(
	ctx: GitContext,
	operation = "Repository maintenance",
): Promise<void> {
	const config = await readConfig(ctx);
	if (
		config.extensions?.partialclone ||
		Object.values(config).some((section) => section.promisor === "true")
	) {
		throw new Error(`${operation} is not supported for partial clones`);
	}
}
