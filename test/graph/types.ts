/**
 * A step in building a graph scenario.
 *
 * - A string is a shell command (git or echo, etc.)
 * - `{ write: path, content }` writes a file
 * - `{ cmd, env }` runs a command with a specific env
 *
 * Commit-producing commands (commit, merge, cherry-pick, rebase --continue)
 * automatically get incrementing timestamps so hashes are deterministic
 * relative to order.
 */
export type Step =
	| string
	| { write: string; content: string }
	| { cmd: string; env?: Record<string, string> };

export interface GraphScenario {
	description?: string;
	/** Initial files on VFS before any commands. Default: { "/repo/README.md": "# Hello" } */
	files?: Record<string, string>;
	/** Steps to build the repo state. */
	steps: Step[];
	/** Log commands to compare. Default: ["git log --graph --all --oneline"] */
	logCommands?: string[];
}
