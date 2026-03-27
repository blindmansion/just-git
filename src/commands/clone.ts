import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import { err, fatal } from "../lib/command-utils.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { buildIndex, defaultStat, writeIndex } from "../lib/index.ts";
import { readCommit } from "../lib/object-db.ts";
import { basename, resolve } from "../lib/path.ts";
import { logRef } from "../lib/reflog.ts";
import { createSymbolicRef, ensureRemoteHead, updateRef } from "../lib/refs.ts";
import { findRepo, initRepository } from "../lib/repo.ts";
import { applyShallowUpdates } from "../lib/shallow.ts";
import { createTransportForUrl, stripAndCacheCredentials } from "../lib/transport/remote.ts";
import type { ShallowFetchOptions, Transport } from "../lib/transport/transport.ts";
import { flattenTree } from "../lib/tree-ops.ts";
import type { GitContext, GitRepo, ObjectId } from "../lib/types.ts";
import { checkoutTree } from "../lib/worktree.ts";
import { a, type Command, f, o } from "../parse/index.ts";

export function registerCloneCommand(parent: Command, ext?: GitExtensions) {
	parent.command("clone", {
		description: "Clone a repository into a new directory",
		args: [
			a.string().name("repository").describe("Repository to clone"),
			a.string().name("directory").describe("Target directory").optional(),
		],
		options: {
			bare: f().describe("Create a bare clone"),
			branch: o.string().alias("b").describe("Checkout this branch instead of HEAD"),
			depth: o.number().describe("Create a shallow clone with history truncated to N commits"),
			singleBranch: f().describe("Clone only the history of the specified or default branch"),
			noSingleBranch: f().describe("Clone all branches even with --depth"),
			noTags: f().describe("Don't clone any tags"),
			noCheckout: f().alias("n").describe("Don't create a checkout"),
		},
		handler: async (args, ctx) => {
			const repository = args.repository;
			if (!repository) {
				return fatal("You must specify a repository to clone.");
			}

			const isHttp = repository.startsWith("http://") || repository.startsWith("https://");
			const branchOpt = args.branch;

			// For local paths, verify the source is a git repository.
			// Try resolveRemote with the raw URL first (supports custom URL
			// schemes like "server://repo"), then fall back to path resolution.
			let sourceRepo: GitRepo | null = null;
			let sourcePath = repository;
			if (!isHttp) {
				if (ext?.resolveRemote) {
					sourceRepo = await ext.resolveRemote(repository);
				}
				if (!sourceRepo) {
					sourcePath = resolve(ctx.cwd, repository);
					sourceRepo = await findRepo(ctx.fs, sourcePath);
				}
				if (!sourceRepo) {
					return fatal(`repository '${repository}' does not exist`);
				}
			} else {
				sourcePath = stripAndCacheCredentials(repository, ext?.credentialCache).url;
			}

			// Determine target directory name
			let targetName = args.directory;
			if (!targetName) {
				let base: string;
				if (isHttp || repository.includes("://")) {
					base = sourcePath.split("/").pop() ?? sourcePath;
				} else {
					base = basename(sourcePath);
				}
				if (base.endsWith(".git")) {
					base = base.slice(0, -4);
				}
				targetName = base;
			}
			const targetPath = resolve(ctx.cwd, targetName);
			const rej = await ext?.hooks?.preClone?.({
				repository: sourcePath,
				targetPath,
				bare: args.bare,
				branch: branchOpt ?? null,
			});
			if (isRejection(rej)) return err(rej.message ?? "");

			// Check if target already exists and is non-empty
			if (await ctx.fs.exists(targetPath)) {
				try {
					const entries = await ctx.fs.readdir(targetPath);
					if (entries.length > 0) {
						return fatal(
							`destination path '${targetName}' already exists and is not an empty directory.`,
						);
					}
				} catch {
					return fatal(
						`destination path '${targetName}' already exists and is not an empty directory.`,
					);
				}
			}

			// Create target directory
			await ctx.fs.mkdir(targetPath, { recursive: true });

			// Initialize the new repository
			const { ctx: baseCtx } = await initRepository(ctx.fs, targetPath, {
				bare: args.bare,
			});
			const newCtx: GitContext = ext ? { ...baseCtx, ...ext } : baseCtx;

			const depthOpt = args.depth;
			const singleBranch = args.singleBranch || (depthOpt !== undefined && !args.noSingleBranch);
			const noTags = args.noTags || singleBranch;
			const noCheckout = args.noCheckout;

			// Build config — written once after branch tracking is known
			const config = await readConfig(newCtx);

			// Create transport and fetch all objects
			let transport: Transport;
			try {
				transport = await createTransportForUrl(
					newCtx,
					sourcePath,
					ctx.env,
					sourceRepo ?? undefined,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : "";
				if (msg.startsWith("network")) return fatal(msg);
				return fatal(`repository '${repository}' does not exist`);
			}
			const remoteRefs = await transport.advertiseRefs();

			if (remoteRefs.length === 0) {
				config['remote "origin"'] = {
					url: sourcePath,
					fetch: "+refs/heads/*:refs/remotes/origin/*",
				};
				await writeConfig(newCtx, config);
				await ext?.hooks?.postClone?.({
					repo: newCtx,
					repository: sourcePath,
					targetPath,
					bare: args.bare,
					branch: branchOpt ?? null,
				});
				return {
					stdout: "",
					stderr: `Cloning into '${targetName}'...\nwarning: You appear to have cloned an empty repository.\n`,
					exitCode: 0,
				};
			}

			// Resolve the default branch before building wants so
			// single-branch mode knows which branch to fetch.
			// -b flag takes priority (fail fast if invalid), then symref
			// capability, then HEAD hash matching, then first branch.
			let defaultBranch: string | null = null;
			let defaultHash: ObjectId | null = null;

			if (branchOpt) {
				const match = remoteRefs.find((r) => r.name === `refs/heads/${branchOpt}`);
				if (!match) {
					return fatal(`Remote branch '${branchOpt}' not found in upstream origin`);
				}
				defaultBranch = branchOpt;
				defaultHash = match.hash;
			} else {
				const headSymref = transport.headTarget;
				if (
					headSymref?.startsWith("refs/heads/") &&
					remoteRefs.some((r) => r.name === headSymref)
				) {
					defaultBranch = headSymref.slice("refs/heads/".length);
					defaultHash = remoteRefs.find((r) => r.name === headSymref)?.hash ?? null;
				}

				if (!defaultBranch) {
					const headRef = remoteRefs.find((r) => r.name === "HEAD");
					if (headRef) {
						const match = remoteRefs.find(
							(r) => r.name.startsWith("refs/heads/") && r.hash === headRef.hash,
						);
						if (match) {
							defaultBranch = match.name.slice("refs/heads/".length);
							defaultHash = match.hash;
						}
					}
				}

				if (!defaultBranch) {
					const firstBranch = remoteRefs.find((r) => r.name.startsWith("refs/heads/"));
					if (firstBranch) {
						defaultBranch = firstBranch.name.slice("refs/heads/".length);
						defaultHash = firstBranch.hash;
					}
				}
			}

			// Build remote config with refspec narrowed for single-branch
			const remoteSection: Record<string, string> = {
				url: sourcePath,
				fetch:
					singleBranch && defaultBranch
						? `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`
						: "+refs/heads/*:refs/remotes/origin/*",
			};
			if (noTags) {
				remoteSection.tagOpt = "--no-tags";
			}
			config['remote "origin"'] = remoteSection;

			// Build wants list — single-branch limits to target branch only
			const wants: ObjectId[] = [];
			const seen = new Set<ObjectId>();
			for (const ref of remoteRefs) {
				if (ref.name === "HEAD") continue;

				if (ref.name.startsWith("refs/heads/")) {
					if (singleBranch && defaultBranch) {
						if (ref.name !== `refs/heads/${defaultBranch}`) continue;
					}
				} else if (ref.name.startsWith("refs/tags/")) {
					if (noTags) continue;
				} else {
					continue;
				}

				if (!seen.has(ref.hash)) {
					seen.add(ref.hash);
					wants.push(ref.hash);
				}
			}

			const shallowOpts: ShallowFetchOptions | undefined =
				depthOpt !== undefined && depthOpt > 0 ? { depth: depthOpt } : undefined;

			if (wants.length > 0) {
				const fetchResult = await transport.fetch(wants, [], shallowOpts);

				if (fetchResult.shallowUpdates) {
					await applyShallowUpdates(newCtx, fetchResult.shallowUpdates);
				}
			}

			// Create remote tracking refs and tags
			const cloneMsg = `clone: from ${sourcePath}`;

			for (const ref of remoteRefs) {
				if (ref.name === "HEAD") continue;

				if (ref.name.startsWith("refs/heads/")) {
					if (singleBranch && defaultBranch) {
						if (ref.name !== `refs/heads/${defaultBranch}`) continue;
					}
					const trackingRef = `refs/remotes/origin/${ref.name.slice("refs/heads/".length)}`;
					await updateRef(newCtx, trackingRef, ref.hash);
					await logRef(newCtx, ctx.env, trackingRef, null, ref.hash, cloneMsg);
				}

				if (ref.name.startsWith("refs/tags/")) {
					if (!noTags) {
						await updateRef(newCtx, ref.name, ref.hash);
					}
				}
			}

			if (args.bare) {
				await writeConfig(newCtx, config);
				if (defaultBranch) {
					await createSymbolicRef(newCtx, "HEAD", `refs/heads/${defaultBranch}`);
				}
				await ext?.hooks?.postClone?.({
					repo: newCtx,
					repository: sourcePath,
					targetPath,
					bare: args.bare,
					branch: defaultBranch,
				});
				return {
					stdout: "",
					stderr: `Cloning into bare repository '${targetName}'...\n`,
					exitCode: 0,
				};
			}

			await ensureRemoteHead(newCtx, "origin", remoteRefs, transport.headTarget);

			// Non-bare: create local branch and checkout
			if (defaultBranch && defaultHash) {
				await updateRef(newCtx, `refs/heads/${defaultBranch}`, defaultHash);
				await createSymbolicRef(newCtx, "HEAD", `refs/heads/${defaultBranch}`);

				await logRef(
					newCtx,
					ctx.env,
					`refs/heads/${defaultBranch}`,
					null,
					defaultHash,
					cloneMsg,
					true,
				);

				config[`branch "${defaultBranch}"`] = {
					remote: "origin",
					merge: `refs/heads/${defaultBranch}`,
				};

				if (!noCheckout) {
					const commit = await readCommit(newCtx, defaultHash);
					await checkoutTree(newCtx, commit.tree);

					const treeEntries = await flattenTree(newCtx, commit.tree);
					const index = buildIndex(
						treeEntries.map((entry) => ({
							path: entry.path,
							mode: parseInt(entry.mode, 8),
							hash: entry.hash,
							stage: 0,
							stat: defaultStat(),
						})),
					);
					await writeIndex(newCtx, index);
				}
			}

			await writeConfig(newCtx, config);

			const response = {
				stdout: "",
				stderr: `Cloning into '${targetName}'...\n`,
				exitCode: 0,
			};
			await ext?.hooks?.postClone?.({
				repo: newCtx,
				repository: sourcePath,
				targetPath,
				bare: args.bare,
				branch: defaultBranch,
			});
			return response;
		},
	});
}
