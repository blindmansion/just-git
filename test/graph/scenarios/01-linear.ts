import type { GraphScenario } from "../types";

export default {
	description: "Straight-line history, no branches",
	steps: [
		"git init",
		"git add .",
		'git commit -m "first"',
		{ write: "a.txt", content: "a" },
		"git add .",
		'git commit -m "second"',
		{ write: "b.txt", content: "b" },
		"git add .",
		'git commit -m "third"',
	],
	logCommands: ["git log --graph --oneline", "git log --graph --all --oneline", "git log --graph"],
} satisfies GraphScenario;
