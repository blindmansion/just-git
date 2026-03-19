import type { GraphScenario } from "../types";

export default {
	description: "Fast-forward merge (linear result)",
	steps: [
		"git init",
		"git add .",
		'git commit -m "initial"',
		"git checkout -b feature",
		{ write: "f.txt", content: "f" },
		"git add .",
		'git commit -m "feat commit"',
		"git checkout main",
		"git merge feature",
	],
	logCommands: ["git log --graph --all --oneline", "git log --graph --oneline"],
} satisfies GraphScenario;
