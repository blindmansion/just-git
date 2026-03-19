import type { GraphScenario } from "../types";

export default {
	description: "Graph + reverse should error",
	steps: [
		"git init",
		"git add .",
		'git commit -m "first"',
		{ write: "a.txt", content: "a" },
		"git add .",
		'git commit -m "second"',
	],
	logCommands: ["git log --graph --reverse"],
} satisfies GraphScenario;
