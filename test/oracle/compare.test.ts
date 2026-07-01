import { describe, expect, test } from "bun:test";
import {
	compare,
	hasErrors,
	type ImplState,
	type ImplWorktreeState,
	type OracleState,
	type OracleWorktreeState,
} from "./compare";

function oracleMain(): OracleWorktreeState {
	return {
		id: "main",
		path: ".",
		headRef: "ref: refs/heads/main",
		headSha: "a".repeat(40),
		index: [],
		workTreeHash: "tree-hash",
		operation: null,
		operationStateHash: null,
		locked: false,
		lockReason: null,
		prunable: null,
		checkoutExists: true,
	};
}

function implMain(): ImplWorktreeState {
	return {
		id: "main",
		path: ".",
		headRef: "ref: refs/heads/main",
		headSha: "a".repeat(40),
		index: new Map(),
		workTreeHash: "tree-hash",
		operation: null,
		operationStateHash: null,
		locked: false,
		lockReason: null,
		prunable: null,
		checkoutExists: true,
	};
}

function baseOracleState(): OracleState {
	return {
		refs: [
			{ refName: "refs/heads/main", sha: "a".repeat(40) },
			{ refName: "refs/heads/topic", sha: "c".repeat(40) },
			{ refName: "refs/remotes/origin/HEAD", sha: "d".repeat(40) },
		],
		stashHashes: [],
		worktrees: [oracleMain()],
	};
}

function baseImplState(): ImplState {
	return {
		refs: new Map([
			["refs/heads/main", "a".repeat(40)],
			["refs/heads/topic", "c".repeat(40)],
			["refs/remotes/origin/HEAD", "d".repeat(40)],
		]),
		stashHashes: [],
		worktrees: [implMain()],
	};
}

describe("oracle compare severity", () => {
	test("treats checked-out branch ref drift as an error", () => {
		const oracle = baseOracleState();
		const impl = baseImplState();
		impl.refs.set("refs/heads/main", "b".repeat(40));

		const divergences = compare(oracle, impl);
		const branchDiv = divergences.find((d) => d.field === "ref:refs/heads/main");

		expect(branchDiv?.severity).toBe("error");
		expect(hasErrors(divergences)).toBe(true);
	});

	test("treats attached head_sha drift as an error", () => {
		const oracle = baseOracleState();
		const impl = baseImplState();
		impl.worktrees[0]!.headSha = "b".repeat(40);
		impl.refs.set("refs/heads/main", "b".repeat(40));

		const divergences = compare(oracle, impl);
		const headDiv = divergences.find((d) => d.field === "head_sha");

		expect(headDiv?.severity).toBe("error");
		expect(hasErrors(divergences)).toBe(true);
	});

	test("keeps non-current branch ref drift as a warning", () => {
		const oracle = baseOracleState();
		const impl = baseImplState();
		impl.refs.set("refs/heads/topic", "b".repeat(40));

		const divergences = compare(oracle, impl);
		const branchDiv = divergences.find((d) => d.field === "ref:refs/heads/topic");

		expect(branchDiv?.severity).toBe("warn");
		expect(hasErrors(divergences)).toBe(false);
	});

	test("keeps detached head_sha drift as a warning", () => {
		const oracle = baseOracleState();
		const impl = baseImplState();
		oracle.worktrees[0]!.headRef = null;
		impl.worktrees[0]!.headRef = null;
		impl.worktrees[0]!.headSha = "b".repeat(40);
		oracle.refs = [{ refName: "refs/heads/main", sha: "a".repeat(40) }];
		impl.refs = new Map([["refs/heads/main", "a".repeat(40)]]);

		const divergences = compare(oracle, impl);
		const headDiv = divergences.find((d) => d.field === "head_sha");

		expect(headDiv?.severity).toBe("warn");
		expect(hasErrors(divergences)).toBe(false);
	});

	test("keeps remote HEAD ref drift as a warning", () => {
		const oracle = baseOracleState();
		const impl = baseImplState();
		impl.refs.set("refs/remotes/origin/HEAD", "e".repeat(40));

		const divergences = compare(oracle, impl);
		const remoteHeadDiv = divergences.find((d) => d.field === "ref:refs/remotes/origin/HEAD");

		expect(remoteHeadDiv?.severity).toBe("warn");
		expect(hasErrors(divergences)).toBe(false);
	});
});
