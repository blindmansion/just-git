import { describe, expect, test } from "bun:test";
import type { ObjectWriteEvent, RefUpdateEvent } from "../../src/hooks";
import { BASIC_REPO } from "../fixtures";
import { createHookBash } from "./helpers";

describe("low-level events", () => {
	test("object:write and ref:update fire on commit", async () => {
		const { bash, git } = createHookBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");

		const writes: ObjectWriteEvent[] = [];
		const updates: RefUpdateEvent[] = [];
		git.on("object:write", (e) => {
			writes.push(e);
		});
		git.on("ref:update", (e) => {
			updates.push(e);
		});

		await bash.exec('git commit -m "test"');
		expect(writes.some((w) => w.type === "commit")).toBe(true);
		expect(updates.some((u) => u.ref === "refs/heads/main")).toBe(true);
	});

	test("ref:delete fires on branch deletion", async () => {
		const { bash, git } = createHookBash({ files: BASIC_REPO });
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');
		await bash.exec("git branch feature");

		const refs: string[] = [];
		git.on("ref:delete", (event) => {
			refs.push(event.ref);
		});

		await bash.exec("git branch -d feature");
		expect(refs).toEqual(["refs/heads/feature"]);
	});
});
