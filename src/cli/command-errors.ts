// Command error primitives: the `CommandResult` shape returned by every git
// command and the small helpers for building/detecting error results. This is
// the CLI command contract; it lives in `cli/` so `lib` never speaks it — lib
// gatherers surface typed outcomes that the command tier maps to a result here.

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export function fatal(msg: string): CommandResult {
	return { stdout: "", stderr: `fatal: ${msg}\n`, exitCode: 128 };
}

export function err(msg: string, code = 1): CommandResult {
	return { stdout: "", stderr: msg, exitCode: code };
}

export function isCommandError<T>(result: T | CommandResult): result is CommandResult {
	return typeof result === "object" && result !== null && "exitCode" in (result as object);
}

/** Standard "ambiguous argument" error for unknown revisions/paths. */
export function ambiguousArgError(rev: string): CommandResult {
	return fatal(
		`ambiguous argument '${rev}': unknown revision or path not in the working tree.\n` +
			"Use '--' to separate paths from revisions, like this:\n" +
			"'git <command> [<revision>...] -- [<file>...]'",
	);
}
