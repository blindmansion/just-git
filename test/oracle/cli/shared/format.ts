// ANSI color helpers (no-op if not a TTY)
const isTTY = process.stderr.isTTY ?? false;
export const color = {
	green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
	yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
	red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
	cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
	dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
};

/** Strip ANSI escape codes for clean log file output. */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function truncateCommand(cmd: string, maxLen: number): string {
	if (cmd.length <= maxLen) return cmd;
	return `${cmd.slice(0, maxLen)}...`;
}

export function fmt(value: unknown, maxLen = 120): string {
	if (typeof value === "string") {
		const s = JSON.stringify(value);
		if (s.length <= maxLen) return s;
		return `${s.slice(0, maxLen - 3)}..."`;
	}
	return String(value);
}

export function indent(text: string, prefix = "  "): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

export function fmtMs(ms: number): string {
	if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
	if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
	if (ms >= 100) return `${ms.toFixed(0)}ms`;
	if (ms >= 10) return `${ms.toFixed(1)}ms`;
	return `${ms.toFixed(2)}ms`;
}

export function fmtBytes(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${bytes}B`;
}
