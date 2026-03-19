/**
 * Opinionated hook presets built on top of the minimal ServerHooks interface.
 */

import type {
	PostReceiveEvent,
	PreReceiveEvent,
	Rejection,
	ServerHooks,
	UpdateEvent,
} from "./types.ts";

export interface StandardHooksConfig {
	/** Branches that cannot be force-pushed to or deleted. */
	protectedBranches?: string[];
	/** Reject all non-fast-forward pushes globally. */
	denyNonFastForward?: boolean;
	/** Reject all ref deletions globally. */
	denyDeletes?: boolean;
	/** Reject deletion and overwrite of tags. Tags are treated as immutable. */
	denyDeleteTags?: boolean;
	/** Return false to reject the entire push (e.g. check Authorization header). */
	authorizePush?: (request: Request) => boolean | Promise<boolean>;
	/** Called after refs are updated. */
	onPush?: (event: PostReceiveEvent) => void | Promise<void>;
}

/**
 * Build a standard set of server hooks from a simple config.
 *
 * Covers the most common policies (branch protection, fast-forward
 * enforcement, authorization, post-push callbacks) so users don't
 * have to wire hooks manually for typical setups.
 */
export function createStandardHooks(config: StandardHooksConfig): ServerHooks {
	const {
		protectedBranches = [],
		denyNonFastForward = false,
		denyDeletes = false,
		denyDeleteTags = false,
		authorizePush,
		onPush,
	} = config;

	const protectedSet = new Set(
		protectedBranches.map((b) => (b.startsWith("refs/") ? b : `refs/heads/${b}`)),
	);

	const hooks: ServerHooks = {};

	if (authorizePush || protectedSet.size > 0) {
		hooks.preReceive = async (event: PreReceiveEvent): Promise<void | Rejection> => {
			if (authorizePush) {
				const allowed = await authorizePush(event.request);
				if (!allowed) return { reject: true, message: "unauthorized" };
			}

			for (const update of event.updates) {
				if (!protectedSet.has(update.ref)) continue;

				if (update.isDelete) {
					return { reject: true, message: `cannot delete protected branch ${update.ref}` };
				}
				if (!update.isCreate && !update.isFF) {
					return {
						reject: true,
						message: `non-fast-forward push to protected branch ${update.ref}`,
					};
				}
			}
		};
	}

	if (denyNonFastForward || denyDeletes || denyDeleteTags) {
		hooks.update = async (event: UpdateEvent): Promise<void | Rejection> => {
			if (denyDeletes && event.update.isDelete) {
				return { reject: true, message: "ref deletion denied" };
			}
			if (denyDeleteTags && event.update.ref.startsWith("refs/tags/")) {
				if (event.update.isDelete) {
					return { reject: true, message: "tag deletion denied" };
				}
				if (!event.update.isCreate) {
					return { reject: true, message: "tag overwrite denied" };
				}
			}
			if (
				denyNonFastForward &&
				!event.update.isCreate &&
				!event.update.isDelete &&
				!event.update.isFF
			) {
				return { reject: true, message: "non-fast-forward" };
			}
		};
	}

	if (onPush) {
		hooks.postReceive = onPush;
	}

	return hooks;
}
