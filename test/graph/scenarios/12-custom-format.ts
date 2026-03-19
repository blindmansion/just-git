import type { GraphScenario } from "../types";

export default {
	description: "Graph with custom format strings",
	steps: [
		"git init",
		"git add .",
		'git commit -m "first"',
		{ write: "a.txt", content: "a" },
		"git add .",
		'git commit -m "second"',
		"git checkout -b topic",
		{ write: "b.txt", content: "b" },
		"git add .",
		'git commit -m "topic"',
		"git checkout main",
		{ write: "c.txt", content: "c" },
		"git add .",
		'git commit -m "main work"',
		'git merge topic -m "merge"',
	],
	logCommands: ['git log --graph --format="%h %s"', 'git log --graph --all --format="%h %s"'],
} satisfies GraphScenario;
