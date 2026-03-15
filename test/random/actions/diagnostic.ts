import { pickAnyBranch, pickFile } from "../pickers";
import type { Action } from "../types";

const addDryRun: Action = {
	name: "addDryRun",
	category: "diagnostic",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("add -n .");
		return { description: "git add -n .", result };
	},
};

const logVariant: Action = {
	name: "logVariant",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const n = rng.int(1, 8);
		const flags = rng.pick([
			"--oneline",
			"",
			"--all --oneline",
			"--decorate --oneline",
			"--reverse --oneline",
			"--reverse",
			'--format="%H"',
			'--format="%h %s"',
			"--pretty=short",
		]);
		const cmd = flags ? `log ${flags} -n ${n}` : `log -n ${n}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const logPath: Action = {
	name: "logPath",
	category: "diagnostic",
	canRun: (state) => state.hasCommits && state.files.length > 0,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const file = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!file) return { description: "logPath: no file", result: null };
		const n = rng.int(1, 5);
		const result = await harness.git(`log --oneline -n ${n} -- ${file}`);
		return { description: `git log --oneline -n ${n} -- ${file}`, result };
	},
};

const logGrep: Action = {
	name: "logGrep",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const n = rng.int(1, 5);
		const result = await harness.git(`log --oneline -n ${n} --grep=commit-`);
		return {
			description: `git log --oneline -n ${n} --grep=commit-`,
			result,
		};
	},
};

const logRef: Action = {
	name: "logRef",
	category: "diagnostic",
	canRun: (state) => state.hasCommits && state.branches.length >= 1,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const branch = pickAnyBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!branch) return { description: "logRef: no branch", result: null };
		const n = rng.int(1, 5);
		const oneline = rng.bool(0.7) ? " --oneline" : "";
		const result = await harness.git(`log ${branch}${oneline} -n ${n}`);
		return { description: `git log ${branch}${oneline} -n ${n}`, result };
	},
};

const logFormat: Action = {
	name: "logFormat",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const n = rng.int(1, 5);
		const fmt = rng.pick(["%H", "%h %s", "%h %an %s", "%H %P", "%an <%ae> %at"]);
		const cmd = `log --format="${fmt}" -n ${n}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const logPretty: Action = {
	name: "logPretty",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const n = rng.int(1, 3);
		const preset = rng.pick(["oneline", "short", "full", "fuller"]);
		const cmd = `log --pretty=${preset} -n ${n}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const logRange: Action = {
	name: "logRange",
	category: "diagnostic",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state) {
		const branches = state.branches;
		const a = rng.pick(branches);
		const others = branches.filter((b) => b !== a);
		if (others.length === 0) return { description: "logRange: need 2 branches", result: null };
		const b = rng.pick(others);
		const threeDot = rng.bool(0.5);
		const sep = threeDot ? "..." : "..";
		const n = rng.int(1, 10);
		const flag = rng.pick(["--oneline", "", "--oneline --reverse"]);
		const cmd = `log ${flag} -n ${n} ${a}${sep}${b}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const statusVariant: Action = {
	name: "statusVariant",
	category: "diagnostic",
	canRun: () => true,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const cmd = rng.pick(["status", "status -s", "status --porcelain"]);
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const diffUnstaged: Action = {
	name: "diffUnstaged",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("diff");
		return { description: "git diff", result };
	},
};

const diffCached: Action = {
	name: "diffCached",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("diff --cached");
		return { description: "git diff --cached", result };
	},
};

const diffFormat: Action = {
	name: "diffFormat",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const flag = rng.pick(["--stat", "--name-only", "--name-status", "--shortstat", "--numstat"]);
		const cached = rng.bool(0.5) ? " --cached" : "";
		const result = await harness.git(`diff ${flag}${cached}`);
		return { description: `git diff ${flag}${cached}`, result };
	},
};

const diffRange: Action = {
	name: "diffRange",
	category: "diagnostic",
	canRun: (state) => state.branches.length >= 2 && state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state) {
		const branches = state.branches;
		const a = rng.pick(branches);
		const others = branches.filter((b) => b !== a);
		if (others.length === 0) return { description: "diffRange: need 2 branches", result: null };
		const b = rng.pick(others);
		const threeDot = rng.bool(0.5);
		const sep = threeDot ? "..." : "..";
		const flag = rng.pick(["", " --name-only", " --name-status", " --stat", " --shortstat"]);
		const cmd = `diff${flag} ${a}${sep}${b}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const branchList: Action = {
	name: "branchList",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("branch");
		return { description: "git branch", result };
	},
};

const branchListVerbose: Action = {
	name: "branchListVerbose",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("branch -v");
		return { description: "git branch -v", result };
	},
};

const showHead: Action = {
	name: "showHead",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("show");
		return { description: "git show", result };
	},
};

const showRevPath: Action = {
	name: "showRevPath",
	category: "diagnostic",
	canRun: (state) => state.hasCommits && state.files.length > 0,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "showRevPath: no file", result: null };
		const rev = rng.bool(0.6) ? "HEAD" : rng.pick(state.branches);
		const result = await harness.git(`show ${rev}:${path}`);
		return { description: `git show ${rev}:${path}`, result };
	},
};

const blameFile: Action = {
	name: "blameFile",
	category: "diagnostic",
	canRun: (state) => state.hasCommits && state.files.length > 0,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const path = pickFile(rng, state, { fuzzRate: fuzz?.fileRate });
		if (!path) return { description: "blameFile: no file", result: null };
		const result = await harness.git(`blame HEAD -- ${path}`);
		return { description: `git blame HEAD -- ${path}`, result };
	},
};

const revParseHead: Action = {
	name: "revParseHead",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const short = rng.bool(0.4);
		const cmd = short ? "rev-parse --short HEAD" : "rev-parse HEAD";
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const revParseAbbrevRef: Action = {
	name: "revParseAbbrevRef",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("rev-parse --abbrev-ref HEAD");
		return { description: "git rev-parse --abbrev-ref HEAD", result };
	},
};

const revParseVerify: Action = {
	name: "revParseVerify",
	category: "diagnostic",
	canRun: (state) => state.hasCommits && state.branches.length >= 1,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const ref = pickAnyBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!ref) return { description: "revParseVerify: no branch", result: null };
		const result = await harness.git(`rev-parse --verify ${ref}`);
		return { description: `git rev-parse --verify ${ref}`, result };
	},
};

const revParseSymbolic: Action = {
	name: "revParseSymbolic",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("rev-parse --symbolic-full-name HEAD");
		return {
			description: "git rev-parse --symbolic-full-name HEAD",
			result,
		};
	},
};

const lsFiles: Action = {
	name: "lsFiles",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("ls-files");
		return { description: "git ls-files", result };
	},
};

const lsFilesStage: Action = {
	name: "lsFilesStage",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("ls-files --stage");
		return { description: "git ls-files --stage", result };
	},
};

const lsFilesUnmerged: Action = {
	name: "lsFilesUnmerged",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("ls-files --unmerged");
		return { description: "git ls-files --unmerged", result };
	},
};

const lsFilesOthers: Action = {
	name: "lsFilesOthers",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness) {
		const result = await harness.git("ls-files --others --exclude-standard");
		return {
			description: "git ls-files --others --exclude-standard",
			result,
		};
	},
};

const reflogShow: Action = {
	name: "reflogShow",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const n = rng.int(1, 8);
		const cmd = `reflog -n ${n}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

const reflogShowBranch: Action = {
	name: "reflogShowBranch",
	category: "diagnostic",
	canRun: (state) => state.hasCommits && state.branches.length >= 1,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const branch = pickAnyBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		if (!branch) return { description: "reflogShowBranch: no branch", result: null };
		const n = rng.int(1, 5);
		const result = await harness.git(`reflog show ${branch} -n ${n}`);
		return { description: `git reflog show ${branch} -n ${n}`, result };
	},
};

const reflogExists: Action = {
	name: "reflogExists",
	category: "diagnostic",
	canRun: (state) => state.hasCommits && state.branches.length >= 1,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng, state, fuzz?) {
		const branch = pickAnyBranch(rng, state, { fuzzRate: fuzz?.branchRate });
		const ref = rng.bool(0.3) ? "HEAD" : branch ? `refs/heads/${branch}` : "HEAD";
		const result = await harness.git(`reflog exists ${ref}`);
		return { description: `git reflog exists ${ref}`, result };
	},
};

const logDiff: Action = {
	name: "logDiff",
	category: "diagnostic",
	canRun: (state) => state.hasCommits,
	precondition: () => true,
	weight: () => 1,
	async execute(harness, rng) {
		const n = rng.int(1, 5);
		const flag = rng.pick([
			"--name-status",
			"--name-only",
			"--stat",
			"--shortstat",
			"--numstat",
			"-p",
		]);
		const oneline = rng.bool(0.3) ? " --oneline" : "";
		const cmd = `log ${flag}${oneline} -n ${n}`;
		const result = await harness.git(cmd);
		return { description: `git ${cmd}`, result };
	},
};

export const DIAGNOSTIC_ACTIONS: readonly Action[] = [
	addDryRun,
	logVariant,
	logPath,
	logGrep,
	logRef,
	logFormat,
	logPretty,
	logRange,
	logDiff,
	statusVariant,
	diffUnstaged,
	diffCached,
	diffFormat,
	diffRange,
	branchList,
	branchListVerbose,
	showHead,
	showRevPath,
	blameFile,
	revParseHead,
	revParseAbbrevRef,
	revParseVerify,
	revParseSymbolic,
	lsFiles,
	lsFilesStage,
	lsFilesUnmerged,
	lsFilesOthers,
	reflogShow,
	reflogShowBranch,
	reflogExists,
];
