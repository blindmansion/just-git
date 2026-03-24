import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import { abbreviateHash, fatal, isCommandError, requireGitContext } from "../lib/command-utils.ts";
import { readConfig } from "../lib/config.ts";
import { getReflogIdentity } from "../lib/identity.ts";
import { join } from "../lib/path.ts";
import { appendReflog, ZERO_HASH } from "../lib/reflog.ts";
import { deleteRef, listRefs, resolveRef, updateRef } from "../lib/refs.ts";
import {
	applyShallowUpdates,
	INFINITE_DEPTH,
	isShallowRepo,
	readShallowCommits,
} from "../lib/shallow.ts";
import { mapRefspec, parseRefspec, type Refspec } from "../lib/transport/refspec.ts";
import { resolveRemoteTransport } from "../lib/transport/remote.ts";
import type { RemoteRef, ShallowFetchOptions } from "../lib/transport/transport.ts";
import type { ExecResult } from "../hooks.ts";
import type { GitContext, ObjectId } from "../lib/types.ts";
import { a, type Command, f, o } from "../parse/index.ts";

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
			depth: o.number().describe("Limit fetching to the specified number of commits"),
			unshallow: f().describe("Convert a shallow repository to a complete one"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			if (args.depth !== undefined && args.unshallow) {
				return fatal("--depth and --unshallow cannot be used together");
			}
			if (args.unshallow && !(await isShallowRepo(gitCtx))) {
				return fatal("--unshallow on a complete repository does not make sense");
			}

			let depth: number | undefined = args.depth;
			if (args.unshallow) {
				depth = INFINITE_DEPTH;
			}

			if (args.all) {
				if (args.remote) {
					return fatal("fetch --all does not take a remote argument");
				}
				const config = await readConfig(gitCtx);
				const remoteNames: string[] = [];
				for (const section of Object.keys(config)) {
					const match = section.match(/^remote "(.+)"$/);
					if (match?.[1]) remoteNames.push(match[1]);
				}
				if (remoteNames.length === 0) {
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				const allStderr: string[] = [];
				let lastExit = 0;
				for (const name of remoteNames) {
					const result = await fetchOneRemote(
						gitCtx,
						name,
						undefined,
						args.prune,
						args.tags,
						ctx.env,
						ext,
						depth,
					);
					if (result.stderr) allStderr.push(result.stderr);
					if (result.exitCode !== 0) lastExit = result.exitCode;
				}
				return { stdout: "", stderr: allStderr.join(""), exitCode: lastExit };
			}

			const remoteName = args.remote || "origin";
			return fetchOneRemote(
				gitCtx,
				remoteName,
				args.refspec,
				args.prune,
				args.tags,
				ctx.env,
				ext,
				depth,
			);
		},
	});
}

async function fetchOneRemote(
	gitCtx: GitContext,
	remoteName: string,
	rawRefspecs: string[] | undefined,
	prune: boolean,
	tags: boolean,
	env: Map<string, string>,
	ext?: GitExtensions,
	depth?: number,
): Promise<ExecResult> {
	let resolved;
	try {
		resolved = await resolveRemoteTransport(gitCtx, remoteName, env);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "";
		if (msg.startsWith("network")) return fatal(msg);
		throw e;
	}
	if (!resolved) {
		return fatal(`'${remoteName}' does not appear to be a git repository`);
	}

	const { transport, config } = resolved;

	let fetchSpecs: Refspec[];
	if (rawRefspecs && rawRefspecs.length > 0) {
		fetchSpecs = rawRefspecs.map(parseRefspec);
	} else {
		fetchSpecs = [parseRefspec(config.fetchRefspec)];
	}
	const preFetchRej = await ext?.hooks?.preFetch?.({
		repo: gitCtx,
		remote: remoteName,
		url: config.url,
		refspecs: fetchSpecs.map((s) => `${s.src}:${s.dst}`),
		prune,
		tags,
	});
	if (isRejection(preFetchRej)) {
		return { stdout: "", stderr: preFetchRej.message ?? "", exitCode: 1 };
	}

	const remoteRefs = await transport.advertiseRefs();

	if (remoteRefs.length === 0) {
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	const localRefs = await listRefs(gitCtx);
	const haves: ObjectId[] = localRefs.map((r) => r.hash);
	const localHead = await resolveRef(gitCtx, "HEAD");
	if (localHead) haves.push(localHead);

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

	if (tags) {
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

	const haveSet = new Set(haves);
	const filteredWants = wants.filter((w) => !haveSet.has(w));

	let shallowOpts: ShallowFetchOptions | undefined;
	const existingShallows = depth !== undefined ? await readShallowCommits(gitCtx) : undefined;
	if (depth !== undefined) {
		shallowOpts = { depth, existingShallows };
	}

	// When depth/unshallow is requested, we must call fetch even with no
	// new wants so the shallow boundary negotiation can happen.
	const effectiveWants = filteredWants.length > 0 ? filteredWants : shallowOpts ? wants : [];

	if (effectiveWants.length > 0) {
		const fetchResult = await transport.fetch(effectiveWants, haves, shallowOpts);

		if (fetchResult.shallowUpdates) {
			await applyShallowUpdates(gitCtx, fetchResult.shallowUpdates, existingShallows);
		}
	}

	const ident = await getReflogIdentity(gitCtx, env);
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

	if (!tags) {
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
				stderr.push(` * [new tag]         ${shortenRef(ref.name)} -> ${shortenRef(ref.name)}\n`);
			}
		}
	}

	if (prune) {
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

	const headRef = remoteRefs.find((r) => r.name === "HEAD");
	if (headRef) {
		const fetchHeadPath = join(gitCtx.gitDir, "FETCH_HEAD");
		const headBranch = remoteRefs.find(
			(r) => r.name.startsWith("refs/heads/") && r.hash === headRef.hash,
		);
		const branchDesc = headBranch
			? `branch '${headBranch.name.slice("refs/heads/".length)}' of`
			: "of";
		await gitCtx.fs.writeFile(fetchHeadPath, `${headRef.hash}\t\t${branchDesc} ${config.url}\n`);
	}

	const response = {
		stdout: "",
		stderr: stderr.join(""),
		exitCode: 0,
	};
	await ext?.hooks?.postFetch?.({
		repo: gitCtx,
		remote: remoteName,
		url: config.url,
		updatedRefCount: refUpdates.length,
	});
	return response;
}

function shortenRef(name: string): string {
	if (name.startsWith("refs/heads/")) return name.slice("refs/heads/".length);
	if (name.startsWith("refs/tags/")) return name.slice("refs/tags/".length);
	if (name.startsWith("refs/remotes/")) return name.slice("refs/remotes/".length);
	return name;
}
