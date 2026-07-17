import { describe, expect, test } from "bun:test";
import type { GitRepo } from "../../src/lib/types.ts";
import { buildPolicyHooks, mergePolicyAndHooks } from "../../src/server/policy.ts";
import type {
	Auth,
	PreReceiveEvent,
	RefUpdate,
	RefUpdateCreate,
	RefUpdateDelete,
	RefUpdateModify,
	ServerHooks,
	UpdateEvent,
} from "../../src/server/types.ts";

function stubRepo(): GitRepo {
	return {
		objectStore: {} as GitRepo["objectStore"],
		refStore: {} as GitRepo["refStore"],
	};
}

const auth: Auth = {
	transport: "http",
	request: new Request("http://localhost/repo"),
};

function modify(overrides: Partial<RefUpdateModify> = {}): RefUpdateModify {
	return {
		ref: "refs/heads/main",
		oldHash: "a".repeat(40),
		newHash: "b".repeat(40),
		isFF: true,
		isCreate: false,
		isDelete: false,
		...overrides,
	};
}

function deletion(ref = "refs/heads/main"): RefUpdateDelete {
	return {
		ref,
		oldHash: "a".repeat(40),
		newHash: "0".repeat(40),
		isFF: false,
		isCreate: false,
		isDelete: true,
	};
}

function creation(ref: string): RefUpdateCreate {
	return {
		ref,
		oldHash: null,
		newHash: "b".repeat(40),
		isFF: false,
		isCreate: true,
		isDelete: false,
	};
}

function preReceiveEvent(update: RefUpdate): PreReceiveEvent {
	return { repo: stubRepo(), repoId: "repo", updates: [update], auth };
}

function updateEvent(update: RefUpdate): UpdateEvent {
	return { repo: stubRepo(), repoId: "repo", update, auth };
}

describe("server policy hooks", () => {
	test("normalizes protected branch names and rejects destructive updates", async () => {
		const hooks = buildPolicyHooks({ protectedBranches: ["main", "refs/heads/release"] });

		expect(
			await hooks.preReceive!(preReceiveEvent(modify({ ref: "refs/heads/main", isFF: false }))),
		).toEqual({
			reject: true,
			message: "non-fast-forward push to protected branch refs/heads/main",
		});
		expect(await hooks.preReceive!(preReceiveEvent(deletion("refs/heads/release")))).toEqual({
			reject: true,
			message: "cannot delete protected branch refs/heads/release",
		});
		expect(
			await hooks.preReceive!(preReceiveEvent(modify({ ref: "refs/heads/topic" }))),
		).toBeUndefined();
	});

	test("applies global non-fast-forward and deletion rules", async () => {
		const hooks = buildPolicyHooks({ denyNonFastForward: true, denyDeletes: true });

		expect(await hooks.update!(updateEvent(deletion()))).toEqual({
			reject: true,
			message: "ref deletion denied",
		});
		expect(await hooks.update!(updateEvent(modify({ isFF: false })))).toEqual({
			reject: true,
			message: "non-fast-forward",
		});
		expect(await hooks.update!(updateEvent(modify()))).toBeUndefined();
	});

	test("allows new tags but rejects immutable tag deletion and overwrite", async () => {
		const hooks = buildPolicyHooks({ immutableTags: true });

		expect(await hooks.update!(updateEvent(creation("refs/tags/v1")))).toBeUndefined();
		expect(await hooks.update!(updateEvent(deletion("refs/tags/v1")))).toEqual({
			reject: true,
			message: "tag deletion denied",
		});
		expect(await hooks.update!(updateEvent(modify({ ref: "refs/tags/v1" })))).toEqual({
			reject: true,
			message: "tag overwrite denied",
		});
	});

	test("runs policy before user hooks and short-circuits on rejection", async () => {
		const calls: string[] = [];
		const userHooks: ServerHooks = {
			preReceive: () => {
				calls.push("user");
			},
		};
		const hooks = mergePolicyAndHooks({ protectedBranches: ["main"] }, userHooks)!;

		const rejected = await hooks.preReceive!(
			preReceiveEvent(modify({ ref: "refs/heads/main", isFF: false })),
		);
		expect(rejected).toEqual({
			reject: true,
			message: "non-fast-forward push to protected branch refs/heads/main",
		});
		expect(calls).toEqual([]);

		await hooks.preReceive!(preReceiveEvent(modify({ ref: "refs/heads/topic" })));
		expect(calls).toEqual(["user"]);
	});

	test("returns user hooks unchanged when no policy is configured", () => {
		const hooks: ServerHooks = { postReceive: () => {} };
		expect(mergePolicyAndHooks(undefined, hooks)).toBe(hooks);
	});
});
