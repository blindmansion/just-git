import type { GraphScenario } from "../types";

export default {
	description: "Two feature branches merged sequentially into main",
	steps: [
		"git init",
		"git add .",
		'git commit -m "root"',
		// Branch A
		"git checkout -b feat-a",
		{ write: "a1.txt", content: "a1" },
		"git add .",
		'git commit -m "a-1"',
		{ write: "a2.txt", content: "a2" },
		"git add .",
		'git commit -m "a-2"',
		// Branch B
		"git checkout main",
		"git checkout -b feat-b",
		{ write: "b1.txt", content: "b1" },
		"git add .",
		'git commit -m "b-1"',
		// Main work
		"git checkout main",
		{ write: "m.txt", content: "m" },
		"git add .",
		'git commit -m "main-1"',
		// Merge A, then B
		'git merge feat-a -m "merge A"',
		'git merge feat-b -m "merge B"',
	],
	logCommands: ["git log --graph --all --oneline", "git log --graph --oneline", "git log --graph"],
} satisfies GraphScenario;
