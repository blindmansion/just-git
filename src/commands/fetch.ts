import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import {
	abbreviateHash,
	buildRefUpdateLines,
	fatal,
	formatTransferRefLines,
	isCommandError,
	requireGitContext,
	type TransferRefLine,
} from "../lib/command-utils.ts";
import { readConfig } from "../lib/config.ts";
import {
	autoFollowReachableTags,
	collectFetchHaves,
	normalizeFetchDepth,
	prepareShallowFetch,
	resolveRemoteTransportOrError,
} from "../lib/fetch-helpers.ts";
import { getReflogIdentity } from "../lib/identity.ts";
import { join } from "../lib/path.ts";
import { appendReflog, ZERO_HASH } from "../lib/reflog.ts";
import {
	deleteRef,
	ensureRemoteHead,
	listRefs,
	resolveRef,
	shortenRef,
	updateRef,
} from "../lib/refs.ts";
import { applyShallowUpdates } from "../lib/shallow.ts";
import { mapRefspec, parseRefspec, type Refspec } from "../lib/transport/refspec.ts";
import type { RemoteRef } from "../lib/transport/transport.ts";
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

			const depthResult = await normalizeFetchDepth(gitCtx, args);
			if (isCommandError(depthResult)) return depthResult;
			const { depth } = depthResult;

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

interface FetchRefUpdate {
	remote: RemoteRef;
	localRef: string;
	force: boolean;
}

interface PlannedFetchRefUpdates {
	wants: ObjectId[];
	refUpdates: FetchRefUpdate[];
	matchedSpecs: boolean[];
}

interface AppliedFetchRefUpdate extends FetchRefUpdate {
	oldHash: string | null;
}

function resolveFetchSpecs(rawRefspecs: string[] | undefined, configSpec: Refspec): Refspec[] {
	if (!rawRefspecs || rawRefspecs.length === 0) {
		return [configSpec];
	}

	return rawRefspecs.map((raw) => {
		const spec = parseRefspec(raw);
		if (raw.includes(":")) return spec;
		// Bare name (no colon) — expand through configured fetch refspec
		// to determine the proper destination ref. Real git resolves bare
		// names by trying the literal value, refs/heads/<name>, then
		// refs/tags/<name> against the configured refspec.
		for (const candidate of [spec.src, `refs/heads/${spec.src}`, `refs/tags/${spec.src}`]) {
			const dst = mapRefspec(configSpec, candidate);
			if (dst !== null) {
				return { force: spec.force || configSpec.force, src: candidate, dst };
			}
		}
		return spec;
	});
}

function planFetchRefUpdates(
	remoteRefs: RemoteRef[],
	fetchSpecs: Refspec[],
): PlannedFetchRefUpdates {
	const wants: ObjectId[] = [];
	const seen = new Set<ObjectId>();
	const refUpdates: FetchRefUpdate[] = [];
	const matchedSpecs = new Array(fetchSpecs.length).fill(false);

	for (const ref of remoteRefs) {
		if (ref.name === "HEAD") continue;

		for (const [specIndex, spec] of fetchSpecs.entries()) {
			const dst = mapRefspec(spec, ref.name);
			if (dst === null) continue;

			matchedSpecs[specIndex] = true;
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

	return { wants, refUpdates, matchedSpecs };
}

function validateExplicitFetchSpecs(
	rawRefspecs: string[] | undefined,
	fetchSpecs: Refspec[],
	matchedSpecs: boolean[],
): ExecResult | null {
	if (!rawRefspecs || rawRefspecs.length === 0) return null;

	for (const [specIndex, spec] of fetchSpecs.entries()) {
		if (!matchedSpecs[specIndex] && !spec.src.includes("*")) {
			return fatal(`couldn't find remote ref ${spec.src}`);
		}
	}
	return null;
}

async function applyFetchRefUpdates(
	gitCtx: GitContext,
	refUpdates: FetchRefUpdate[],
	ident: Awaited<ReturnType<typeof getReflogIdentity>>,
	tags: boolean,
): Promise<{
	refLines: TransferRefLine[];
	hadTagRejection: boolean;
	appliedUpdates: AppliedFetchRefUpdate[];
}> {
	const refLines: TransferRefLine[] = [];
	let hadTagRejection = false;
	const appliedUpdates: AppliedFetchRefUpdate[] = [];
	const orderedTagEntries: Array<
		| TransferRefLine
		| {
				update: FetchRefUpdate;
				oldHash: string | null;
		  }
	> = [];

	for (const update of refUpdates) {
		const oldHash = await resolveRef(gitCtx, update.localRef);
		if (
			tags &&
			update.remote.name.startsWith("refs/tags/") &&
			oldHash &&
			oldHash !== update.remote.hash
		) {
			hadTagRejection = true;
			orderedTagEntries.push({
				prefix: " ! [rejected]",
				from: shortenRef(update.remote.name),
				to: shortenRef(update.localRef),
				suffix: " (would clobber existing tag)",
			});
			continue;
		}

		appliedUpdates.push({ ...update, oldHash });
		if (update.localRef.startsWith("refs/tags/")) {
			orderedTagEntries.push({ update, oldHash });
		}
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
	}

	const branchApplied = appliedUpdates.filter((u) => !u.localRef.startsWith("refs/tags/"));
	refLines.push(...buildRefUpdateLines(branchApplied, shortenRef, abbreviateHash));
	for (const entry of orderedTagEntries) {
		if ("prefix" in entry) {
			refLines.push(entry);
			continue;
		}
		refLines.push(
			...buildRefUpdateLines(
				[{ ...entry.update, oldHash: entry.oldHash }],
				shortenRef,
				abbreviateHash,
			),
		);
	}

	return { refLines, hadTagRejection, appliedUpdates };
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
	const resolved = await resolveRemoteTransportOrError(gitCtx, remoteName, env);
	if (isCommandError(resolved)) return resolved;
	const { transport, config } = resolved;

	const configSpec = parseRefspec(config.fetchRefspec);
	const fetchSpecs = resolveFetchSpecs(rawRefspecs, configSpec);
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
		if (rawRefspecs && rawRefspecs.length > 0) {
			for (const spec of fetchSpecs) {
				if (!spec.src.includes("*")) {
					return fatal(`couldn't find remote ref ${spec.src}`);
				}
			}
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	const { wants, refUpdates, matchedSpecs } = planFetchRefUpdates(remoteRefs, fetchSpecs);
	const missingRefError = validateExplicitFetchSpecs(rawRefspecs, fetchSpecs, matchedSpecs);
	if (missingRefError) return missingRefError;
	const seen = new Set(wants);

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

	const haves = await collectFetchHaves(gitCtx);
	const haveSet = new Set(haves);
	const filteredWants = wants.filter((w) => !haveSet.has(w));

	const { existingShallows, shallowOpts } = await prepareShallowFetch(gitCtx, depth);

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
	const { refLines, hadTagRejection, appliedUpdates } = await applyFetchRefUpdates(
		gitCtx,
		refUpdates,
		ident,
		tags,
	);

	if (!tags) {
		refLines.push(
			...(await autoFollowReachableTags({
				gitCtx,
				transport,
				remoteRefs,
				ident,
				reflogAction: "fetch",
			})),
		);
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
			const rawRef = await gitCtx.refStore.readRef(ref.name);
			if (rawRef?.type === "symbolic") continue;
			const branchName = ref.name.slice(prunePrefix.length + 1);
			if (branchName === "HEAD") continue;
			if (!remoteHeads.has(branchName)) {
				await deleteRef(gitCtx, ref.name);
				refLines.push({
					prefix: " - [deleted]",
					from: "(none)",
					to: `${remoteName}/${branchName}`,
				});
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

		if (!rawRefspecs || rawRefspecs.length === 0) {
			await ensureRemoteHead(gitCtx, remoteName, remoteRefs, transport.headTarget);
		}
	}

	const stderr =
		refLines.length > 0 ? `From ${config.url}\n${formatTransferRefLines(refLines, 10)}` : "";
	const response = {
		stdout: "",
		stderr,
		exitCode: hadTagRejection ? 1 : 0,
	};
	await ext?.hooks?.postFetch?.({
		repo: gitCtx,
		remote: remoteName,
		url: config.url,
		updatedRefCount: appliedUpdates.length,
	});
	return response;
}
