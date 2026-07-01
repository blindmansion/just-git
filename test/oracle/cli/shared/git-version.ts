import { color } from "./format";

export async function getGitVersion(): Promise<{
	major: number;
	minor: number;
	patch: string;
	raw: string;
} | null> {
	try {
		const proc = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		const match = stdout.trim().match(/git version (\d+)\.(\d+)\.(.+)/);
		if (!match) return null;
		return {
			major: parseInt(match[1], 10),
			minor: parseInt(match[2], 10),
			patch: match[3],
			raw: stdout.trim(),
		};
	} catch {
		return null;
	}
}

const TARGET_GIT_MAJOR = 2;
const TARGET_GIT_MINOR = 53;

export async function warnIfGitVersionMismatch(): Promise<void> {
	const version = await getGitVersion();
	if (!version) {
		console.warn(
			color.yellow("Warning: could not determine git version. Oracle traces target git 2.53.x.\n"),
		);
		return;
	}
	if (version.major !== TARGET_GIT_MAJOR || version.minor !== TARGET_GIT_MINOR) {
		console.warn(
			color.yellow(
				`Warning: ${version.raw}\n` +
					`Oracle traces target git ${TARGET_GIT_MAJOR}.${TARGET_GIT_MINOR}.x. ` +
					`Version differences may cause false test failures.\n`,
			),
		);
	}
}
