/**
 * Declarative server policy and hook composition.
 *
 * Policy hooks run before user hooks. Hook composition preserves rejection
 * short-circuiting, post-receive isolation, and advertisement filter chaining.
 */

import { isRejection } from "../hooks.ts";
import type {
	Auth,
	RefAdvertisement,
	Rejection,
	ServerHooks,
	ServerPolicy,
	UpdateEvent,
} from "./types.ts";

export function buildPolicyHooks<A = Auth>(policy: ServerPolicy): ServerHooks<A> {
	const {
		protectedBranches = [],
		denyNonFastForward = false,
		denyDeletes = false,
		immutableTags = false,
	} = policy;

	const protectedSet = new Set(
		protectedBranches.map((branch) =>
			branch.startsWith("refs/") ? branch : `refs/heads/${branch}`,
		),
	);

	const hooks: ServerHooks<A> = {};

	if (protectedSet.size > 0) {
		hooks.preReceive = async (event) => {
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

	if (denyNonFastForward || denyDeletes || immutableTags) {
		hooks.update = async (event: UpdateEvent<A>): Promise<void | Rejection> => {
			if (denyDeletes && event.update.isDelete) {
				return { reject: true, message: "ref deletion denied" };
			}
			if (immutableTags && event.update.ref.startsWith("refs/tags/")) {
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

	return hooks;
}

export function mergePolicyAndHooks<A>(
	policy: ServerPolicy | undefined,
	hooks: ServerHooks<A> | undefined,
): ServerHooks<A> | undefined {
	const policyHooks = policy ? buildPolicyHooks<A>(policy) : undefined;
	if (policyHooks && hooks) return composeHooks(policyHooks, hooks);
	return policyHooks ?? hooks;
}

/**
 * Compose multiple hook sets into a single `ServerHooks` object.
 *
 * - **Pre-hooks** (`preReceive`, `update`): run in order, short-circuit
 *   on the first `Rejection`.
 * - **Post-hooks** (`postReceive`): run all in order. Each is individually
 *   try/caught so one failure doesn't prevent the rest from running.
 * - **Filter hooks** (`advertiseRefs`): chain — each hook receives the
 *   refs returned by the previous one. Short-circuits on `Rejection`.
 *   Returning void passes through unchanged.
 */
export function composeHooks<A = Auth>(
	...hookSets: (ServerHooks<A> | undefined)[]
): ServerHooks<A> {
	const sets = hookSets.filter((hooks): hooks is ServerHooks<A> => hooks != null);
	if (sets.length === 0) return {};
	if (sets.length === 1) return sets[0]!;

	const composed: ServerHooks<A> = {};

	const preReceiveHandlers = sets.filter((set) => set.preReceive).map((set) => set.preReceive!);
	if (preReceiveHandlers.length > 0) {
		composed.preReceive = async (event) => {
			for (const handler of preReceiveHandlers) {
				const result = await handler(event);
				if (isRejection(result)) return result;
			}
		};
	}

	const updateHandlers = sets.filter((set) => set.update).map((set) => set.update!);
	if (updateHandlers.length > 0) {
		composed.update = async (event) => {
			for (const handler of updateHandlers) {
				const result = await handler(event);
				if (isRejection(result)) return result;
			}
		};
	}

	const postReceiveHandlers = sets.filter((set) => set.postReceive).map((set) => set.postReceive!);
	if (postReceiveHandlers.length > 0) {
		composed.postReceive = async (event) => {
			for (const handler of postReceiveHandlers) {
				try {
					await handler(event);
				} catch {
					// Fire-and-forget: one handler failing does not block the rest.
				}
			}
		};
	}

	const advertiseRefsHandlers = sets
		.filter((set) => set.advertiseRefs)
		.map((set) => set.advertiseRefs!);
	if (advertiseRefsHandlers.length > 0) {
		composed.advertiseRefs = async (event) => {
			let refs: RefAdvertisement[] = event.refs;
			for (const handler of advertiseRefsHandlers) {
				const result = await handler({ ...event, refs });
				if (isRejection(result)) return result;
				if (result) refs = result;
			}
			return refs;
		};
	}

	return composed;
}
