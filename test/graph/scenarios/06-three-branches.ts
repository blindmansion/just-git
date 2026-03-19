import type { GraphScenario } from "../types";

export default {
	description: "Three unmerged branches from same root",
	steps: [
		"git init",
		"git add .",
		'git commit -m "root"',
		"git checkout -b a",
		{ write: "a.txt", content: "a" },
		"git add .",
		'git commit -m "a-1"',
		{ write: "a2.txt", content: "a2" },
		"git add .",
		'git commit -m "a-2"',
		"git checkout main",
		"git checkout -b b",
		{ write: "b.txt", content: "b" },
		"git add .",
		'git commit -m "b-1"',
		"git checkout main",
		"git checkout -b c",
		{ write: "c.txt", content: "c" },
		"git add .",
		'git commit -m "c-1"',
	],
	logCommands: ["git log --graph --all --oneline"],
} satisfies GraphScenario;
