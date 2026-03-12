import { Bash, type BashOptions } from "just-bash";
import { createGit, type GitOptions } from "../../src/git";
import { TEST_ENV } from "../fixtures";
export { TEST_ENV };

export function createHookBash(
	options: Partial<BashOptions> = {},
	gitOptions?: GitOptions,
): {
	bash: Bash;
	git: ReturnType<typeof createGit>;
} {
	const git = createGit(gitOptions);
	const customCommands = [git, ...(options.customCommands ?? [])];
	const bash = new Bash({
		cwd: "/repo",
		env: TEST_ENV,
		...options,
		customCommands,
	});
	return { bash, git };
}
