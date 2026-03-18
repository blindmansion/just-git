import type { GitExtensions } from "../git.ts";
import { isRejection } from "../hooks.ts";
import { err, fatal } from "../lib/command-utils.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { getReflogIdentity } from "../lib/identity.ts";
import { buildIndex, defaultStat, writeIndex } from "../lib/index.ts";
import { readCommit } from "../lib/object-db.ts";
import { basename, resolve } from "../lib/path.ts";
import { appendReflog, ZERO_HASH } from "../lib/reflog.ts";
import { createSymbolicRef, updateRef } from "../lib/refs.ts";
import { findGitDir, initRepository } from "../lib/repo.ts";
import { createTransportForUrl } from "../lib/transport/remote.ts";
import type { Transport } from "../lib/transport/transport.ts";
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
		},
		handler: async (args, ctx) => {
			const repository = args.repository;
			if (!repository) {
				return fatal("You must specify a repository to clone.");
			}

			const isHttp = repository.startsWith("http://") || repository.startsWith("https://");
			const sourcePath = isHttp ? repository : resolve(ctx.cwd, repository);
			const branchOpt = args.branch;

			// Determine target directory name
			let targetName = args.directory;
			if (!targetName) {
				let base = isHttp ? (repository.split("/").pop() ?? repository) : basename(sourcePath);
				if (base.endsWith(".git")) {
					base = base.slice(0, -4);
				}
				targetName = base;
			}
			const targetPath = resolve(ctx.cwd, targetName);
			const rej = await ext?.hooks?.preClone?.({
				repository,
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

			// For local paths, verify the source is a git repository
			let sourceRepo: GitRepo | null = null;
			if (!isHttp) {
				if (ext?.resolveRemote) {
					sourceRepo = await ext.resolveRemote(sourcePath);
				}
				if (!sourceRepo) {
					sourceRepo = await findGitDir(ctx.fs, sourcePath);
				}
				if (!sourceRepo) {
					return fatal(`repository '${repository}' does not exist`);
				}
			}

			// Create target directory
			await ctx.fs.mkdir(targetPath, { recursive: true });

			// Initialize the new repository
			const { ctx: baseCtx } = await initRepository(ctx.fs, targetPath, {
				bare: args.bare,
			});
			const newCtx: GitContext = ext
				? {
						...baseCtx,
						hooks: ext.hooks,
						credentialProvider: ext.credentialProvider,
						identityOverride: ext.identityOverride,
						fetchFn: ext.fetchFn,
						networkPolicy: ext.networkPolicy,
						resolveRemote: ext.resolveRemote,
					}
				: baseCtx;

			// Set up the "origin" remote
			const config = await readConfig(newCtx);
			config['remote "origin"'] = {
				url: sourcePath,
				fetch: "+refs/heads/*:refs/remotes/origin/*",
			};
			await writeConfig(newCtx, config);

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
				await ext?.hooks?.postClone?.({
					repo: baseCtx,
					repository,
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

			// Determine which objects to fetch (all branch/tag refs)
			const wants: ObjectId[] = [];
			const seen = new Set<ObjectId>();
			for (const ref of remoteRefs) {
				if (ref.name === "HEAD") continue;
				if (!seen.has(ref.hash)) {
					seen.add(ref.hash);
					wants.push(ref.hash);
				}
			}

			if (wants.length > 0) {
				await transport.fetch(wants, []);
			}

			// Create remote tracking refs and find the default branch
			const headRef = remoteRefs.find((r) => r.name === "HEAD");
			let defaultBranch: string | null = null;
			let defaultHash: ObjectId | null = null;
			const ident = await getReflogIdentity(newCtx, ctx.env);
			const cloneMsg = `clone: from ${sourcePath}`;

			// Use symref capability if available (HTTP transport)
			const headSymref = transport.headTarget;
			if (headSymref?.startsWith("refs/heads/") && remoteRefs.some((r) => r.name === headSymref)) {
				defaultBranch = headSymref.slice("refs/heads/".length);
				defaultHash = remoteRefs.find((r) => r.name === headSymref)?.hash ?? null;
			}

			for (const ref of remoteRefs) {
				if (ref.name === "HEAD") continue;

				if (ref.name.startsWith("refs/heads/")) {
					const branchName = ref.name.slice("refs/heads/".length);
					const trackingRef = `refs/remotes/origin/${branchName}`;
					await updateRef(newCtx, trackingRef, ref.hash);
					await appendReflog(newCtx, trackingRef, {
						oldHash: ZERO_HASH,
						newHash: ref.hash,
						name: ident.name,
						email: ident.email,
						timestamp: ident.timestamp,
						tz: ident.tz,
						message: cloneMsg,
					});

					// Fallback: match HEAD hash if symref wasn't available
					if (!defaultBranch && headRef && ref.hash === headRef.hash) {
						defaultBranch = branchName;
						defaultHash = ref.hash;
					}
				}

				if (ref.name.startsWith("refs/tags/")) {
					await updateRef(newCtx, ref.name, ref.hash);
				}
			}

			// If -b was specified, use that branch
			if (branchOpt) {
				const branchHash = remoteRefs.find((r) => r.name === `refs/heads/${branchOpt}`);
				if (!branchHash) {
					return fatal(`Remote branch '${branchOpt}' not found in upstream origin`);
				}
				defaultBranch = branchOpt;
				defaultHash = branchHash.hash;
			}

			// Fall back to first branch if HEAD hash didn't match
			if (!defaultBranch) {
				const firstBranch = remoteRefs.find((r) => r.name.startsWith("refs/heads/"));
				if (firstBranch) {
					defaultBranch = firstBranch.name.slice("refs/heads/".length);
					defaultHash = firstBranch.hash;
				}
			}

			if (args.bare) {
				// Bare repos: set HEAD to the default branch
				if (defaultBranch) {
					await createSymbolicRef(newCtx, "HEAD", `refs/heads/${defaultBranch}`);
				}
				await ext?.hooks?.postClone?.({
					repo: newCtx,
					repository,
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

			// Set origin/HEAD to point to the default branch
			if (defaultBranch) {
				await createSymbolicRef(
					newCtx,
					"refs/remotes/origin/HEAD",
					`refs/remotes/origin/${defaultBranch}`,
				);
			}

			// Non-bare: create local branch and checkout
			if (defaultBranch && defaultHash) {
				await updateRef(newCtx, `refs/heads/${defaultBranch}`, defaultHash);
				await createSymbolicRef(newCtx, "HEAD", `refs/heads/${defaultBranch}`);

				const branchReflog = {
					oldHash: ZERO_HASH,
					newHash: defaultHash,
					name: ident.name,
					email: ident.email,
					timestamp: ident.timestamp,
					tz: ident.tz,
					message: cloneMsg,
				};
				await appendReflog(newCtx, `refs/heads/${defaultBranch}`, branchReflog);
				await appendReflog(newCtx, "HEAD", branchReflog);

				// Set up tracking config
				const updatedConfig = await readConfig(newCtx);
				updatedConfig[`branch "${defaultBranch}"`] = {
					remote: "origin",
					merge: `refs/heads/${defaultBranch}`,
				};
				await writeConfig(newCtx, updatedConfig);

				// Checkout the working tree
				const commit = await readCommit(newCtx, defaultHash);
				await checkoutTree(newCtx, commit.tree);

				// Build the index from the tree
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

			const response = {
				stdout: "",
				stderr: `Cloning into '${targetName}'...\n`,
				exitCode: 0,
			};
			await ext?.hooks?.postClone?.({
				repo: newCtx,
				repository,
				targetPath,
				bare: args.bare,
				branch: defaultBranch,
			});
			return response;
		},
	});
}
