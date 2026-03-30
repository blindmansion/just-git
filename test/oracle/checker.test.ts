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

	test("log range matcher accepts empty versus non-empty timestamp-walk drift", () => {
		const expected = `commit ${"a".repeat(40)}\nAuthor: Test <test@test.com>\n`;
		expect(
			checkerTestUtils.logRangeTimestampWalkerDiffers("git log HEAD..main", expected, ""),
		).toBe(true);
	});

	test("placeholder steps now have their output validated", async () => {
		// Step 0: git init — real snapshot
		const initResult = await captureReplayState("git init");
		const initSnapshot = implStateToSnapshot(initResult.state);

		// Build a two-step trace: step 0 has a real snapshot, step 1 is a
		// placeholder (EMPTY_SNAPSHOT) with a deliberately wrong exit code.
		// Previously placeholders were skipped entirely — now output should
		// be checked, catching the exit code mismatch.
		const { dbPath, store, close } = await createTempDb();
		const traceId = store.createTrace(1, "placeholder-output-check");
		store.recordStep(
			traceId,
			0,
			{
				command: "git init",
				exitCode: initResult.output.exitCode,
				stdout: initResult.output.stdout,
				stderr: initResult.output.stderr,
			},
			initSnapshot,
		);
		store.recordStep(
			traceId,
			1,
			{
				command: "git status",
				exitCode: 42,
				stdout: "",
				stderr: "",
			},
			EMPTY_SNAPSHOT,
		);
		close();

		const result = await replayAndCheck(dbPath, traceId);
		expect(result.firstDivergence).not.toBeNull();
		expect(result.firstDivergence?.seq).toBe(1);
		expect(result.firstDivergence?.divergences.some((d) => d.field === "exit_code")).toBe(true);
	});

	test("placeholder steps pass when output matches", async () => {
		const initResult = await captureReplayState("git init");
		const initSnapshot = implStateToSnapshot(initResult.state);

		// Capture what `git status` actually outputs after init by replaying
		// a two-step trace and grabbing the second step's output
		const helper = await createTempDb();
		const helperTrace = helper.store.createTrace(99, "helper");
		helper.store.recordStep(
			helperTrace,
			0,
			{ command: "git init", exitCode: 0, stdout: "", stderr: "" },
			EMPTY_SNAPSHOT,
		);
		helper.store.recordStep(
			helperTrace,
			1,
			{ command: "git status", exitCode: 0, stdout: "", stderr: "" },
			EMPTY_SNAPSHOT,
		);
		helper.close();
		const statusOutput = await replayToStateAndOutput(helper.dbPath, helperTrace, 1);

		const { dbPath, store, close } = await createTempDb();
		const traceId = store.createTrace(1, "placeholder-output-pass");
		store.recordStep(
			traceId,
			0,
			{
				command: "git init",
				exitCode: initResult.output.exitCode,
				stdout: initResult.output.stdout,
				stderr: initResult.output.stderr,
			},
			initSnapshot,
		);
		store.recordStep(
			traceId,
			1,
			{
				command: "git status",
				exitCode: statusOutput.output.exitCode,
				stdout: statusOutput.output.stdout,
				stderr: statusOutput.output.stderr,
			},
			EMPTY_SNAPSHOT,
		);
		close();

		const result = await replayAndCheck(dbPath, traceId);
		expect(result.firstDivergence).toBeNull();
		expect(result.passed).toBe(2);
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
