import type { GraphScenario } from "../types";

export default {
	description: "One feature branch merged back into main",
	steps: [
		"git init",
		"git add .",
		'git commit -m "initial"',
		"git checkout -b feature",
		{ write: "feat.txt", content: "feature\nline2\n" },
		"git add .",
		'git commit -m "feature-1"',
		{ write: "feat2.txt", content: "more feature" },
		"git add .",
		'git commit -m "feature-2"',
		"git checkout main",
		{ write: "main.txt", content: "main work" },
		"git add .",
		'git commit -m "main-1"',
		'git merge feature -m "merge feature"',
		{ write: "after.txt", content: "after" },
		"git add .",
		'git commit -m "after-merge"',
	],
	logCommands: ["git log --graph --all --oneline", "git log --graph --oneline", "git log --graph"],
} satisfies GraphScenario;
