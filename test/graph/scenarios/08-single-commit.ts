import type { GraphScenario } from "../types";

export default {
	description: "Single root commit only",
	steps: ["git init", "git add .", 'git commit -m "only commit"'],
	logCommands: ["git log --graph --oneline", "git log --graph"],
} satisfies GraphScenario;
