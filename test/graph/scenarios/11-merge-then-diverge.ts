import type { GraphScenario } from "../types";

export default {
	description: "Merge, then diverge again from merged state",
	steps: [
		"git init",
		"git add .",
		'git commit -m "root"',
		"git checkout -b topic",
		{ write: "t.txt", content: "topic" },
		"git add .",
		'git commit -m "topic work"',
		"git checkout main",
		{ write: "m.txt", content: "main" },
		"git add .",
		'git commit -m "main work"',
		'git merge topic -m "merge topic"',
		// Now diverge again
		"git checkout -b topic-2",
		{ write: "t2.txt", content: "topic2" },
		"git add .",
		'git commit -m "topic-2 work"',
		"git checkout main",
		{ write: "m2.txt", content: "main2" },
		"git add .",
		'git commit -m "main work 2"',
	],
	logCommands: ["git log --graph --all --oneline"],
} satisfies GraphScenario;
