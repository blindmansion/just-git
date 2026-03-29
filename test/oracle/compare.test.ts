import { describe, expect, test } from "bun:test";
import { compare, hasErrors, type ImplState, type OracleState } from "./compare";

function baseOracleState(): OracleState {
	return {
		head: {
			headRef: "ref: refs/heads/main",
			headSha: "a".repeat(40),
		},
		refs: [
			{ refName: "refs/heads/main", sha: "a".repeat(40) },
			{ refName: "refs/heads/topic", sha: "c".repeat(40) },
			{ refName: "refs/remotes/origin/HEAD", sha: "d".repeat(40) },
		],
		index: [],
		operation: {
			operation: null,
			stateHash: null,
		},
		workTreeHash: "tree-hash",
		stashHashes: [],
	};
}

function baseImplState(): ImplState {
	return {
		headRef: "ref: refs/heads/main",
		headSha: "a".repeat(40),
		refs: new Map([
			["refs/heads/main", "a".repeat(40)],
			["refs/heads/topic", "c".repeat(40)],
			["refs/remotes/origin/HEAD", "d".repeat(40)],
		]),
		index: new Map(),
		workTreeHash: "tree-hash",
		activeOperation: null,
		operationStateHash: null,
		stashHashes: [],
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
		impl.headSha = "b".repeat(40);
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
		oracle.head.headRef = null;
		impl.headRef = null;
		impl.headSha = "b".repeat(40);
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
