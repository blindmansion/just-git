import type { GraphScenario } from "../types";

export default {
	description: "Two branches with interleaved work, then merge both",
	steps: [
		"git init",
		"git add .",
		'git commit -m "root"',
		// Start branch A
		"git checkout -b a",
		{ write: "a1.txt", content: "a1" },
		"git add .",
		'git commit -m "a-1"',
		// Start branch B from root
		"git checkout main",
		"git checkout -b b",
		{ write: "b1.txt", content: "b1" },
		"git add .",
		'git commit -m "b-1"',
		// More work on A
		"git checkout a",
		{ write: "a2.txt", content: "a2" },
		"git add .",
		'git commit -m "a-2"',
		// More work on B
		"git checkout b",
		{ write: "b2.txt", content: "b2" },
		"git add .",
		'git commit -m "b-2"',
		// Main gets work
		"git checkout main",
		{ write: "m.txt", content: "m" },
		"git add .",
		'git commit -m "main-1"',
		// Merge both
		'git merge a -m "merge a"',
		'git merge b -m "merge b"',
	],
	logCommands: ["git log --graph --all --oneline", "git log --graph --oneline"],
} satisfies GraphScenario;
