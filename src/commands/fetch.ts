import type { GitExtensions } from "../git.ts";
import { abbreviateHash, fatal, isCommandError, requireGitContext } from "../lib/command-utils.ts";
import { getReflogIdentity } from "../lib/identity.ts";
import { join } from "../lib/path.ts";
import { appendReflog, ZERO_HASH } from "../lib/reflog.ts";
import { deleteRef, listRefs, resolveRef, updateRef } from "../lib/refs.ts";
import { mapRefspec, parseRefspec, type Refspec } from "../lib/transport/refspec.ts";
import { resolveRemoteTransport } from "../lib/transport/remote.ts";
import type { RemoteRef } from "../lib/transport/transport.ts";
import type { ObjectId } from "../lib/types.ts";
import { a, type Command, f } from "../parse/index.ts";

export function registerFetchCommand(parent: Command, ext?: GitExtensions) {
	parent.command("fetch", {
		description: "Download objects and refs from another repository",
		args: [
			a.string().name("remote").describe("Remote to fetch from").optional(),
			a.string().name("refspec").describe("Refspec(s) to fetch").optional().variadic(),
		],
		options: {
			all: f().describe("Fetch from all remotes"),
			prune: f().alias("p").describe("Remove stale remote-tracking refs"),
			tags: f().describe("Also fetch tags"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			const remoteName = args.remote || "origin";
			let resolved;
			try {
				resolved = await resolveRemoteTransport(gitCtx, remoteName, ctx.env);
			} catch (e) {
				const msg = e instanceof Error ? e.message : "";
				if (msg.startsWith("network")) return fatal(msg);
				throw e;
			}
			if (!resolved) {
				return fatal(`'${remoteName}' does not appear to be a git repository`);
			}

			const { transport, config } = resolved;

			// Determine the fetch refspec(s)
			const rawRefspecs = args.refspec;
			let fetchSpecs: Refspec[];
			if (rawRefspecs && rawRefspecs.length > 0) {
				fetchSpecs = rawRefspecs.map(parseRefspec);
			} else {
				fetchSpecs = [parseRefspec(config.fetchRefspec)];
			}
			if (ext?.hooks) {
				const abort = await ext.hooks.emitPre("pre-fetch", {
					remote: remoteName,
					url: config.url,
					refspecs: fetchSpecs.map((s) => `${s.src}:${s.dst}`),
					prune: args.prune,
					tags: args.tags,
				});
				if (abort) {
					return { stdout: "", stderr: abort.message ?? "", exitCode: 1 };
				}
			}

			// Get remote refs
			const remoteRefs = await transport.advertiseRefs();

			if (remoteRefs.length === 0) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}

			// Collect all local ref hashes as "haves"
			const localRefs = await listRefs(gitCtx);
			const haves: ObjectId[] = localRefs.map((r) => r.hash);
			const localHead = await resolveRef(gitCtx, "HEAD");
			if (localHead) haves.push(localHead);

			// Match remote refs against fetch refspecs to determine wants
			const wants: ObjectId[] = [];
			const seen = new Set<ObjectId>();
			const refUpdates: Array<{
				remote: RemoteRef;
				localRef: string;
				force: boolean;
			}> = [];

			for (const ref of remoteRefs) {
				if (ref.name === "HEAD") continue;

				for (const spec of fetchSpecs) {
					const dst = mapRefspec(spec, ref.name);
					if (dst !== null) {
						refUpdates.push({
							remote: ref,
							localRef: dst,
							force: spec.force,
						});
						if (!seen.has(ref.hash)) {
							seen.add(ref.hash);
							wants.push(ref.hash);
						}
						break;
					}
				}
			}

			// Also fetch tags if --tags
			if (args.tags) {
				for (const ref of remoteRefs) {
					if (ref.name.startsWith("refs/tags/")) {
						refUpdates.push({
							remote: ref,
							localRef: ref.name,
							force: false,
						});
						if (!seen.has(ref.hash)) {
							seen.add(ref.hash);
							wants.push(ref.hash);
						}
					}
				}
			}

			// Remove haves that are also in wants (dedup)
			const haveSet = new Set(haves);
			const filteredWants = wants.filter((w) => !haveSet.has(w));

			// Fetch objects
			if (filteredWants.length > 0) {
				await transport.fetch(filteredWants, haves);
			}

			// Update local tracking refs
			const ident = await getReflogIdentity(gitCtx, ctx.env);
			const stderr: string[] = [];
			stderr.push(`From ${config.url}\n`);

			for (const update of refUpdates) {
				const oldHash = await resolveRef(gitCtx, update.localRef);
				await updateRef(gitCtx, update.localRef, update.remote.hash);
				await appendReflog(gitCtx, update.localRef, {
					oldHash: oldHash ?? ZERO_HASH,
					newHash: update.remote.hash,
					name: ident.name,
					email: ident.email,
					timestamp: ident.timestamp,
					tz: ident.tz,
					message: oldHash ? "fetch" : "fetch: storing head",
				});

				const shortRemote = shortenRef(update.remote.name);
				const shortLocal = shortenRef(update.localRef);

				if (!oldHash) {
					const isTag = update.remote.name.startsWith("refs/tags/");
					const prefix = isTag ? " * [new tag]" : " * [new branch]";
					stderr.push(`${prefix}      ${shortRemote} -> ${shortLocal}\n`);
				} else if (oldHash !== update.remote.hash) {
					const shortOld = abbreviateHash(oldHash);
					const shortNew = abbreviateHash(update.remote.hash);
					stderr.push(`   ${shortOld}..${shortNew}  ${shortRemote} -> ${shortLocal}\n`);
				}
			}

			// Auto-fetch tags that point to fetched objects
			if (!args.tags) {
				for (const ref of remoteRefs) {
					if (!ref.name.startsWith("refs/tags/")) continue;
					if (seen.has(ref.hash)) continue;

					const exists = await resolveRef(gitCtx, ref.name);
					const targetHash = ref.peeledHash ?? ref.hash;
					if (!exists && haveSet.has(targetHash)) {
						await updateRef(gitCtx, ref.name, ref.hash);
						await appendReflog(gitCtx, ref.name, {
							oldHash: ZERO_HASH,
							newHash: ref.hash,
							name: ident.name,
							email: ident.email,
							timestamp: ident.timestamp,
							tz: ident.tz,
							message: "fetch: storing head",
						});
						stderr.push(
							` * [new tag]         ${shortenRef(ref.name)} -> ${shortenRef(ref.name)}\n`,
						);
					}
				}
			}

			// Prune stale remote-tracking refs
			if (args.prune) {
				const prunePrefix = `refs/remotes/${remoteName}`;
				const trackingRefs = await listRefs(gitCtx, prunePrefix);
				const remoteHeads = new Set(
					remoteRefs
						.filter((r) => r.name.startsWith("refs/heads/"))
						.map((r) => r.name.slice("refs/heads/".length)),
				);

				for (const ref of trackingRefs) {
					const branchName = ref.name.slice(prunePrefix.length + 1);
					if (!remoteHeads.has(branchName)) {
						await deleteRef(gitCtx, ref.name);
						stderr.push(` - [deleted]         (none) -> ${remoteName}/${branchName}\n`);
					}
				}
			}

			// Write FETCH_HEAD
			const headRef = remoteRefs.find((r) => r.name === "HEAD");
			if (headRef) {
				const fetchHeadPath = join(gitCtx.gitDir, "FETCH_HEAD");
				// Find the branch name that HEAD points to
				const headBranch = remoteRefs.find(
					(r) => r.name.startsWith("refs/heads/") && r.hash === headRef.hash,
				);
				const branchDesc = headBranch
					? `branch '${headBranch.name.slice("refs/heads/".length)}' of`
					: "of";
				await ctx.fs.writeFile(fetchHeadPath, `${headRef.hash}\t\t${branchDesc} ${config.url}\n`);
			}

			const response = {
				stdout: "",
				stderr: stderr.join(""),
				exitCode: 0,
			};
			await ext?.hooks?.emitPost("post-fetch", {
				remote: remoteName,
				url: config.url,
				refsUpdated: refUpdates.length,
			});
			return response;
		},
	});
}

function shortenRef(name: string): string {
	if (name.startsWith("refs/heads/")) return name.slice("refs/heads/".length);
	if (name.startsWith("refs/tags/")) return name.slice("refs/tags/".length);
	if (name.startsWith("refs/remotes/")) return name.slice("refs/remotes/".length);
	return name;
}
