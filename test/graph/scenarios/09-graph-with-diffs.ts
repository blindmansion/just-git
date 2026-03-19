import type { GraphScenario } from "../types";

export default {
	description: "Graph with --stat and -p to verify diff interleaving",
	steps: [
		"git init",
		"git add .",
		'git commit -m "initial"',
		"git checkout -b feature",
		{ write: "feat.txt", content: "line1\nline2\nline3\n" },
		"git add .",
		'git commit -m "add feature file"',
		"git checkout main",
		{ write: "main.txt", content: "main stuff\n" },
		"git add .",
		'git commit -m "add main file"',
		'git merge feature -m "merge"',
	],
	logCommands: [
		"git log --graph --oneline --stat",
		"git log --graph -p -n2",
		"git log --graph --stat",
	],
} satisfies GraphScenario;
