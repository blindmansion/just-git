// Fetch/pull command-layer guards that speak the CLI contract: they validate
// arguments / resolve a remote transport and return a `CommandResult` error on
// failure. The pure data-gathering counterparts (collectFetchHaves,
// prepareShallowFetch, autoFollowReachableTags) stay in `lib/fetch-helpers.ts`.

import type { CredentialStore } from "../../hooks.ts";
import { type CommandResult, fatal } from "./command-errors.ts";
import { INFINITE_DEPTH, isShallowRepo } from "../../lib/refs/shallow.ts";
import { resolveRemoteTransport } from "../../lib/transport/resolver.ts";
import type { GitContext, GitOperation } from "../../lib/types.ts";

interface NormalizedFetchArgs {
	depth?: number;
}

type ResolvedRemoteTransport = NonNullable<Awaited<ReturnType<typeof resolveRemoteTransport>>>;

export async function normalizeFetchDepth(
	gitCtx: GitContext,
	args: { depth?: number; unshallow?: boolean },
): Promise<NormalizedFetchArgs | CommandResult> {
	if (args.depth !== undefined && args.unshallow) {
		return fatal("--depth and --unshallow cannot be used together");
	}
	if (args.unshallow && !(await isShallowRepo(gitCtx))) {
		return fatal("--unshallow on a complete repository does not make sense");
	}

	return {
		depth: args.unshallow ? INFINITE_DEPTH : args.depth,
	};
}

export async function resolveRemoteTransportOrError(
	gitCtx: GitContext,
	remoteName: string,
	operation: GitOperation,
	env: Map<string, string>,
	buildError: (message: string) => CommandResult = fatal,
	credentialStore?: CredentialStore,
): Promise<ResolvedRemoteTransport | CommandResult> {
	try {
		const resolved = await resolveRemoteTransport(
			gitCtx,
			remoteName,
			operation,
			env,
			credentialStore,
		);
		if (!resolved) {
			return buildError(`'${remoteName}' does not appear to be a git repository`);
		}
		return resolved;
	} catch (e) {
		const msg = e instanceof Error ? e.message : "";
		if (msg.startsWith("network")) return buildError(msg);
		throw e;
	}
}
