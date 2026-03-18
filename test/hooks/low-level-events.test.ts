import { describe, expect, test } from "bun:test";
import type { ObjectWriteEvent, RefUpdateEvent } from "../../src/hooks";
import { BASIC_REPO } from "../fixtures";
import { createHookBash } from "./helpers";

describe("low-level events", () => {
	test("onObjectWrite and onRefUpdate fire on commit", async () => {
		const writes: ObjectWriteEvent[] = [];
		const updates: RefUpdateEvent[] = [];

		const { bash } = createHookBash(
			{ files: BASIC_REPO },
			{
				hooks: {
					onObjectWrite: (e) => {
						writes.push(e);
					},
					onRefUpdate: (e) => {
						updates.push(e);
					},
				},
			},
		);
		await bash.exec("git init");
		await bash.exec("git add .");

		await bash.exec('git commit -m "test"');
		expect(writes.some((w) => w.type === "commit")).toBe(true);
		expect(updates.some((u) => u.ref === "refs/heads/main")).toBe(true);
	});

	test("onRefDelete fires on branch deletion", async () => {
		const refs: string[] = [];

		const { bash } = createHookBash(
			{ files: BASIC_REPO },
			{
				hooks: {
					onRefDelete: (event) => {
						refs.push(event.ref);
					},
				},
			},
		);
		await bash.exec("git init");
		await bash.exec("git add .");
		await bash.exec('git commit -m "init"');
		await bash.exec("git branch feature");

		await bash.exec("git branch -d feature");
		expect(refs).toEqual(["refs/heads/feature"]);
	});
});
