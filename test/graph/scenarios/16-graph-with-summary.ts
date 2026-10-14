import type { GraphScenario } from "../types";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\n`).join("");

export default {
	description: "Graph with --summary, including a commit with no summary lines",
	steps: [
		"git init",
		"git add .",
		'git commit -m "initial"',
		{ write: "big", content: lines(20) },
		{ write: "m", content: "m\n" },
		"chmod +x m",
		"git add .",
		'git commit -m "add files"',
		"git checkout -b side",
		{ write: "s", content: "s\n" },
		"git add s",
		'git commit -m "side"',
		"git checkout main",
		{ write: "big", content: lines(15) },
		"git rm -q m",
		"git mv big big2",
		"chmod +x big2",
		"git add -A",
		'git commit -m "rename and modes"',
		{ write: "README.md", content: "changed\n" },
		'git commit -am "content only"',
		'git merge side -m "merge"',
	],
	logCommands: [
		"git log --graph --summary",
		"git log --graph --oneline --summary",
		"git log --graph --format=%s --summary",
		"git log --graph --stat --summary",
	],
} satisfies GraphScenario;
