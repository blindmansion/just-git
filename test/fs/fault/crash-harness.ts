import { expect } from "bun:test";
import {
	CrashableDurableFileSystem,
	formatEvent,
	SimulatedCrashError,
	type DurableFsEvent,
	type DurableFsSnapshot,
} from "./crashable-durable-fs.ts";

export interface CrashCutContext<C> {
	cut: number;
	event?: DurableFsEvent;
	trace: readonly DurableFsEvent[];
	fs: CrashableDurableFileSystem;
	context: C;
}

export interface CrashReplayScenario<C = undefined> {
	setup(fs: CrashableDurableFileSystem): Promise<void>;
	operation(fs: CrashableDurableFileSystem, context: C): Promise<unknown>;
	createContext?: () => C;
	verifyCut(input: CrashCutContext<C>): Promise<void>;
	verifySuccess?(fs: CrashableDurableFileSystem, context: C): Promise<void>;
	retry?(fs: CrashableDurableFileSystem, context: C): Promise<void>;
}

/**
 * Discover a successful operation's durability events, then replay from one
 * baseline with a process crash before the operation and after every event.
 */
export async function replayCrashCuts<C = undefined>(
	scenario: CrashReplayScenario<C>,
): Promise<readonly DurableFsEvent[]> {
	const baselineFs = new CrashableDurableFileSystem();
	await scenario.setup(baselineFs);
	const baseline = baselineFs.checkpoint();

	const successful = fromBaseline(baseline);
	const successfulContext = makeContext(scenario);
	await scenario.operation(successful, successfulContext);
	const trace = [...successful.events];
	if (scenario.verifySuccess) {
		await scenario.verifySuccess(successful.reboot(), successfulContext);
	}

	for (let cut = 0; cut <= trace.length; cut++) {
		const fs = fromBaseline(baseline);
		const context = makeContext(scenario);
		if (cut > 0) fs.armCrashAfter(cut);
		try {
			if (cut === 0) fs.crashBeforeOperation();
			await scenario.operation(fs, context);
			throw new Error(`crash cut ${cut} did not crash`);
		} catch (error) {
			expect(error, diagnostic(cut, trace, fs)).toBeInstanceOf(SimulatedCrashError);
		}

		const rebooted = fs.reboot();
		try {
			await scenario.verifyCut({
				cut,
				event: cut === 0 ? undefined : trace[cut - 1],
				trace,
				fs: rebooted,
				context,
			});
			if (scenario.retry) await scenario.retry(rebooted, context);
		} catch (error) {
			throw withDiagnostic(error, diagnostic(cut, trace, rebooted));
		}
	}
	return trace;
}

function fromBaseline(snapshot: DurableFsSnapshot): CrashableDurableFileSystem {
	return new CrashableDurableFileSystem(snapshot);
}

function makeContext<C>(scenario: CrashReplayScenario<C>): C {
	return scenario.createContext ? scenario.createContext() : (undefined as C);
}

function diagnostic(
	cut: number,
	trace: readonly DurableFsEvent[],
	fs: CrashableDurableFileSystem,
): string {
	const selected = cut === 0 ? "before operation" : formatEvent(trace[cut - 1]!);
	const formattedTrace = trace
		.map((event, index) => `${index + 1}. ${formatEvent(event)}`)
		.join("\n");
	return [
		`crash cut: ${cut} (${selected})`,
		"successful trace:",
		formattedTrace || "(no events)",
		"tree after reboot:",
		fs.dumpTree(),
	].join("\n");
}

function withDiagnostic(error: unknown, detail: string): Error {
	if (error instanceof Error) {
		error.message = `${error.message}\n\n${detail}`;
		return error;
	}
	return new Error(`${String(error)}\n\n${detail}`);
}
