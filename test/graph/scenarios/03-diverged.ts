import type { GraphScenario } from "../types";

export default {
	description: "Two branches diverged from root, no merge",
	steps: [
		"git init",
		"git add .",
		'git commit -m "root"',
		"git checkout -b branch",
		{ write: "b.txt", content: "b" },
		"git add .",
		'git commit -m "branch-1"',
		{ write: "b2.txt", content: "b2" },
		"git add .",
		'git commit -m "branch-2"',
		"git checkout main",
		{ write: "m.txt", content: "m" },
		"git add .",
		'git commit -m "main-1"',
		{ write: "m2.txt", content: "m2" },
		"git add .",
		'git commit -m "main-2"',
	],
	logCommands: ["git log --graph --all --oneline", "git log --graph --oneline"],
} satisfies GraphScenario;
