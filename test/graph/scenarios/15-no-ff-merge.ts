import type { GraphScenario } from "../types";

export default {
	description: "No-ff merge creates merge commit even for linear history",
	steps: [
		"git init",
		"git add .",
		'git commit -m "initial"',
		"git checkout -b feature",
		{ write: "f.txt", content: "f" },
		"git add .",
		'git commit -m "feature work"',
		"git checkout main",
		'git merge --no-ff feature -m "merge feature"',
	],
	logCommands: ["git log --graph --all --oneline", "git log --graph --oneline"],
} satisfies GraphScenario;
