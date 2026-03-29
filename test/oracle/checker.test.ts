import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GitSnapshot } from "./capture";
import { checkerTestUtils } from "./checker";
import type { ImplState } from "./compare";
import { replayAndCheck, replayToStateAndOutput } from "./impl-harness";
import { initDb } from "./schema";
import { EMPTY_SNAPSHOT } from "./snapshot-delta";
import { OracleStore } from "./store";

const tempDirs = new Set<string>();

afterEach(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
	tempDirs.clear();
});

async function createTempDb(): Promise<{
	dbPath: string;
	store: OracleStore;
	close: () => void;
}> {
	const dir = await mkdtemp(join(tmpdir(), "just-git-oracle-checker-"));
	tempDirs.add(dir);
	const dbPath = join(dir, "trace.sqlite");
	const db = initDb(dbPath);
	return {
		dbPath,
		store: new OracleStore(db),
		close: () => db.close(),
	};
}

function implStateToSnapshot(state: ImplState): GitSnapshot {
	return {
		head: {
			headRef: state.headRef,
			headSha: state.headSha,
		},
		refs: [...state.refs.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([refName, sha]) => ({ refName, sha })),
		index: [...state.index.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => {
				const split = key.lastIndexOf(":");
				return {
					path: key.slice(0, split),
					stage: Number(key.slice(split + 1)),
					mode: value.mode,
					sha: value.sha,
				};
			}),
		operation: {
			operation: state.activeOperation,
			stateHash: state.operationStateHash,
		},
		workTreeHash: state.workTreeHash,
		stashHashes: [...state.stashHashes],
	};
}

function tweakHash(hash: string): string {
	return `${hash[0] === "a" ? "b" : "a"}${hash.slice(1)}`;
}

async function captureReplayState(command: string): Promise<{
	state: ImplState;
	output: { stdout: string; stderr: string; exitCode: number };
}> {
	const { dbPath, store, close } = await createTempDb();
	const traceId = store.createTrace(1, "capture");
	store.recordStep(traceId, 0, { command, exitCode: 0, stdout: "", stderr: "" }, EMPTY_SNAPSHOT);
	close();
	return replayToStateAndOutput(dbPath, traceId, 0);
}

describe("oracle checker tightening", () => {
	test("replay still validates output on warn-level state drift", async () => {
		const command = 'git init && git commit --allow-empty -m "first" && git branch topic';
		const actual = await captureReplayState(command);
		expect(actual.state.refs.has("refs/heads/topic")).toBe(true);

		const snapshot = implStateToSnapshot(actual.state);
		const topicRef = snapshot.refs.find((ref) => ref.refName === "refs/heads/topic");
		expect(topicRef).toBeDefined();
		topicRef!.sha = tweakHash(topicRef!.sha);

		const { dbPath, store, close } = await createTempDb();
		const traceId = store.createTrace(2, "warn-state-output-mismatch");
		store.recordStep(
			traceId,
			0,
			{
				command,
				exitCode: actual.output.exitCode,
				stdout: `${actual.output.stdout}\nintentional oracle mismatch\n`,
				stderr: actual.output.stderr,
			},
			snapshot,
		);
		close();

		const result = await replayAndCheck(dbPath, traceId);
		expect(result.warned).toBe(1);
		expect(result.firstWarning?.seq).toBe(0);
		expect(result.firstDivergence?.seq).toBe(0);
		expect(result.firstDivergence?.divergences.some((d) => d.field === "stdout")).toBe(true);
	});

	test("log range matcher rejects empty versus non-empty output", () => {
		const expected = `commit ${"a".repeat(40)}\nAuthor: Test <test@test.com>\n`;
		expect(
			checkerTestUtils.logRangeTimestampWalkerDiffers("git log HEAD..main", expected, ""),
		).toBe(false);
	});

	test("log range matcher still accepts real subset or superset hash sets", () => {
		const hashA = "a".repeat(40);
		const hashB = "b".repeat(40);
		const expected = `commit ${hashA}\nAuthor: Test <test@test.com>\n\ncommit ${hashB}\nAuthor: Test <test@test.com>\n`;
		const actual = `commit ${hashA}\nAuthor: Test <test@test.com>\n`;
		expect(
			checkerTestUtils.logRangeTimestampWalkerDiffers("git log HEAD..main", expected, actual),
		).toBe(true);
	});
});
