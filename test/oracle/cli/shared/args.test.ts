import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { datasetDir, discoverDatasets } from "./args";

const tempDirs: string[] = [];

function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "just-git-oracle-data-"));
	tempDirs.push(dir);
	return dir;
}

function marker(root: string, path: string, name: "traces.sqlite" | "test-results.log"): void {
	const dir = join(root, ...path.split("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), "");
}

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.length = 0;
});

describe("datasetDir", () => {
	test("resolves nested dataset paths beneath the data directory", () => {
		const root = tempDataDir();
		expect(datasetDir("group/core", root)).toBe(join(root, "group", "core"));
	});

	test("rejects paths that are not stable relative dataset IDs", () => {
		const root = tempDataDir();
		for (const path of ["", ".", "..", "../core", "group/../core", "/tmp/core", "group\\core"]) {
			expect(() => datasetDir(path, root)).toThrow("Invalid oracle dataset path");
		}
	});
});

describe("discoverDatasets", () => {
	test("finds nested dataset leaves and can scope discovery to a subtree", () => {
		const root = tempDataDir();
		marker(root, "flat", "traces.sqlite");
		marker(root, "group/core", "traces.sqlite");
		marker(root, "group/kitchen", "traces.sqlite");
		marker(root, "other/core", "traces.sqlite");

		expect(discoverDatasets("traces.sqlite", undefined, root)).toEqual([
			"flat",
			"group/core",
			"group/kitchen",
			"other/core",
		]);
		expect(discoverDatasets("traces.sqlite", "group", root)).toEqual([
			"group/core",
			"group/kitchen",
		]);
	});

	test("uses the requested artifact as the dataset marker", () => {
		const root = tempDataDir();
		marker(root, "generated", "traces.sqlite");
		marker(root, "tested", "test-results.log");

		expect(discoverDatasets("traces.sqlite", undefined, root)).toEqual(["generated"]);
		expect(discoverDatasets("test-results.log", undefined, root)).toEqual(["tested"]);
	});

	test("stops descending once it finds a dataset marker", () => {
		const root = tempDataDir();
		marker(root, "parent", "traces.sqlite");
		marker(root, "parent/child", "traces.sqlite");

		expect(discoverDatasets("traces.sqlite", undefined, root)).toEqual(["parent"]);
	});

	test("follows directory symlinks without changing their dataset ID", () => {
		const root = tempDataDir();
		const target = tempDataDir();
		marker(target, "core", "traces.sqlite");
		symlinkSync(join(target, "core"), join(root, "linked-core"), "dir");

		expect(discoverDatasets("traces.sqlite", undefined, root)).toEqual(["linked-core"]);
	});
});
