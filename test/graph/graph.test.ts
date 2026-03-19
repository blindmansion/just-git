import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import type { GraphScenario } from "./types";
import { buildVirtual, buildReal } from "./harness";

const scenarioDir = join(import.meta.dir, "scenarios");
const glob = new Bun.Glob("*.ts");
const scenarioFiles: string[] = [];
for await (const file of glob.scan(scenarioDir)) {
	scenarioFiles.push(file);
}
scenarioFiles.sort();

describe("git log --graph", () => {
	for (const file of scenarioFiles) {
		const name = file.replace(/\.ts$/, "");

		test(name, async () => {
			const mod = await import(join(scenarioDir, file));
			const scenario = mod.default as GraphScenario;
			const logCommands = scenario.logCommands ?? ["git log --graph --all --oneline"];

			const virtualResults = await buildVirtual(scenario);
			const realResults = buildReal(scenario);

			for (const cmd of logCommands) {
				const vr = virtualResults.get(cmd)!;
				const rr = realResults.get(cmd)!;
				expect(vr.exitCode).toBe(rr.exitCode);
				expect(vr.stdout).toBe(rr.stdout);
			}
		});
	}
});
