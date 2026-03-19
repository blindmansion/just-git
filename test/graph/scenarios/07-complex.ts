import type { GraphScenario } from "../types";

export default {
	description: "Complex: 3 feature branches, sequential merges, post-merge work",
	steps: [
		"git init",
		"git add .",
		'git commit -m "root"',
		// feat-a: 2 commits
		"git checkout -b feat-a",
		{ write: "a1.txt", content: "a1" },
		"git add .",
		'git commit -m "feat-a: first"',
		{ write: "a2.txt", content: "a2" },
		"git add .",
		'git commit -m "feat-a: second"',
		// feat-b: 2 commits
		"git checkout main",
		"git checkout -b feat-b",
		{ write: "b1.txt", content: "b1" },
		"git add .",
		'git commit -m "feat-b: first"',
		{ write: "b2.txt", content: "b2" },
		"git add .",
		'git commit -m "feat-b: second"',
		// main work
		"git checkout main",
		{ write: "m1.txt", content: "m1" },
		"git add .",
		'git commit -m "main: hotfix"',
		// merge a
		'git merge feat-a -m "merge feat-a"',
		// more main work
		{ write: "m2.txt", content: "m2" },
		"git add .",
		'git commit -m "main: more work"',
		// merge b
		'git merge feat-b -m "merge feat-b"',
		// feat-c off current main
		"git checkout -b feat-c",
		{ write: "c1.txt", content: "c1" },
		"git add .",
		'git commit -m "feat-c: work"',
		// main continues
		"git checkout main",
		{ write: "m3.txt", content: "m3" },
		"git add .",
		'git commit -m "main: final"',
	],
	logCommands: [
		"git log --graph --all --oneline",
		"git log --graph --oneline",
		"git log --graph --oneline --stat",
	],
} satisfies GraphScenario;
