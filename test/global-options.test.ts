import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../src/git";

const USAGE =
	"usage: git [--version] [--help] [-C <path>] [-c <name>=<value>]\n" +
	"           [-p | --paginate | -P | --no-pager] <command> [<args>]\n";

function shell(options?: Parameters<typeof createGit>[0]): Bash {
	return new Bash({ fs: new InMemoryFs(), customCommands: [createGit(options)], cwd: "/" });
}

async function initRepo(bash: Bash): Promise<void> {
	await bash.exec("mkdir -p /r && cd /r && git init -q && echo a > f && git add f");
}

describe("git -c <name>=<value>", () => {
	test("runs the command with the overlay applied to the author identity", async () => {
		const bash = shell();
		await initRepo(bash);
		const commit = await bash.exec("git -c user.name=x -c user.email=x@y.z commit -q -m via-c", {
			cwd: "/r",
		});
		expect(commit.stderr).toBe("");
		expect(commit.exitCode).toBe(0);
		const log = await bash.exec("git log --format='%an <%ae>'", { cwd: "/r" });
		expect(log.stdout).toBe("x <x@y.z>\n");
	});

	test("beats repo config for one invocation and does not persist", async () => {
		const bash = shell();
		await initRepo(bash);
		await bash.exec("git config user.name old", { cwd: "/r" });
		const overlaid = await bash.exec("git -c user.name=tmp config user.name", { cwd: "/r" });
		expect(overlaid.stdout).toBe("tmp\n");
		expect(overlaid.stderr).toBe("");
		expect(overlaid.exitCode).toBe(0);
		const after = await bash.exec("git config user.name", { cwd: "/r" });
		expect(after.stdout).toBe("old\n");
		expect(after.exitCode).toBe(0);
	});

	test("reaches a caller that spells the key in camelCase", async () => {
		const bash = shell();
		await initRepo(bash);
		await bash.exec("echo junk > u && mkdir d && echo x > d/y", { cwd: "/r" });
		const clean = await bash.exec("git -c clean.requireForce=false clean", { cwd: "/r" });
		expect(clean.stdout).toBe("Removing u\n");
		expect(clean.stderr).toBe("");
		expect(clean.exitCode).toBe(0);
		const ls = await bash.exec("ls", { cwd: "/r" });
		expect(ls.stdout).toBe("d\nf\n");
	});

	test("covers arbitrary keys, lowercasing section and key", async () => {
		const bash = shell();
		await initRepo(bash);
		for (const [arg, key] of [
			["Commit.GPGSign=false", "commit.gpgsign"],
			["core.pager=cat", "core.pager"],
			["color.ui=never", "color.ui"],
			["advice.detachedHead=false", "advice.detachedhead"],
		]) {
			const r = await bash.exec(`git -c ${arg} config ${key}`, { cwd: "/r" });
			expect(r.stdout).toBe(`${arg?.split("=")[1]}\n`);
			expect(r.stderr).toBe("");
			expect(r.exitCode).toBe(0);
		}
	});

	test("init.defaultBranch overlay applies without a repository", async () => {
		const bash = shell();
		await bash.exec("mkdir /n");
		const init = await bash.exec("git -c init.defaultBranch=trunk init -q", { cwd: "/n" });
		expect(init.stderr).toBe("");
		expect(init.exitCode).toBe(0);
		const head = await bash.exec("git branch --show-current", { cwd: "/n" });
		expect(head.stdout).toBe("trunk\n");
		expect(head.exitCode).toBe(0);
	});

	test("a name without '=' reads as true, as parseConfig reads a valueless key", async () => {
		const bash = shell();
		await initRepo(bash);
		const r = await bash.exec("git -c foo.bar config foo.bar", { cwd: "/r" });
		expect(r.stdout).toBe("true\n");
		expect(r.exitCode).toBe(0);
	});

	test("a locked operator override still wins over -c", async () => {
		const bash = shell({ config: { locked: { "user.name": "Locked" } } });
		await initRepo(bash);
		const r = await bash.exec("git -c user.name=agent config user.name", { cwd: "/r" });
		expect(r.stdout).toBe("Locked\n");
		expect(r.stderr).toBe("");
		expect(r.exitCode).toBe(0);
	});

	test("rejects an empty key", async () => {
		const r = await shell().exec("git -c =value status");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("error: empty config key\nfatal: unable to parse command-line config\n");
		expect(r.exitCode).toBe(128);
	});

	test("rejects a key without a section", async () => {
		const r = await shell().exec("git -c foo=1 status");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(
			"error: key does not contain a section: foo\nfatal: unable to parse command-line config\n",
		);
		expect(r.exitCode).toBe(128);
	});

	test("rejects -c with no argument", async () => {
		const r = await shell().exec("git -c");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(`-c expects a configuration string\n${USAGE}`);
		expect(r.exitCode).toBe(129);
	});
});

describe("git -C <path>", () => {
	test("runs the command from the given directory", async () => {
		const bash = shell();
		await initRepo(bash);
		await bash.exec("mkdir /r/sub");
		const status = await bash.exec("git -C r status --short", { cwd: "/" });
		expect(status.stdout).toBe("A  f\n");
		expect(status.exitCode).toBe(0);
		const prefix = await bash.exec("git -C /r -C sub rev-parse --show-prefix", { cwd: "/" });
		expect(prefix.stdout).toBe("sub/\n");
		expect(prefix.exitCode).toBe(0);
	});

	test("fails when the directory does not exist", async () => {
		const r = await shell().exec("git -C nope status");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("fatal: cannot change to 'nope': No such file or directory\n");
		expect(r.exitCode).toBe(128);
	});

	test("rejects -C with no argument", async () => {
		const r = await shell().exec("git -C");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(`no directory given for -C\n${USAGE}`);
		expect(r.exitCode).toBe(129);
	});
});

describe("other leading options", () => {
	test("an unknown global option exits 129 with usage", async () => {
		const r = await shell().exec("git --bogus-opt status");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(`unknown option: --bogus-opt\n${USAGE}`);
		expect(r.exitCode).toBe(129);
	});

	test("an attached -c value is an unknown option, as in git", async () => {
		const r = await shell().exec("git -cfoo.bar=1 status");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(`unknown option: -cfoo.bar=1\n${USAGE}`);
		expect(r.exitCode).toBe(129);
	});

	test("pager options are accepted and ignored", async () => {
		const bash = shell();
		await initRepo(bash);
		for (const opt of ["--no-pager", "-P", "--paginate", "-p"]) {
			const r = await bash.exec(`git ${opt} status --short`, { cwd: "/r" });
			expect(r.stdout).toBe("A  f\n");
			expect(r.stderr).toBe("");
			expect(r.exitCode).toBe(0);
		}
	});

	test("--version and --help keep working", async () => {
		const bash = shell();
		const version = await bash.exec("git --version");
		expect(version.exitCode).toBe(0);
		expect(version.stdout.startsWith("just-git version ")).toBe(true);
		const help = await bash.exec("git --help");
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain("Commands:");
	});
});

describe("dispatch sees the real command", () => {
	test("a blocked command stays blocked behind -c", async () => {
		const git = createGit({ disabled: ["push"] });
		const r = await git.exec("-c user.name=x push", { fs: new InMemoryFs(), cwd: "/" });
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("git: 'push' is not available in this environment\n");
		expect(r.exitCode).toBe(1);
	});

	test("beforeCommand receives the command, its own args, and the -C cwd", async () => {
		const seen: { command: string; args: string[]; cwd: string }[] = [];
		const git = createGit({
			hooks: {
				beforeCommand: ({ command, args, cwd }) => {
					seen.push({ command, args, cwd });
				},
			},
		});
		const fs = new InMemoryFs();
		await fs.mkdir("/w", { recursive: true });
		await git.exec("-C /w -c user.name=x status --short", { fs, cwd: "/" });
		expect(seen).toEqual([{ command: "status", args: ["--short"], cwd: "/w" }]);
	});
});
