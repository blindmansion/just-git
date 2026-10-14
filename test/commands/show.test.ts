import { describe, expect, test } from "bun:test";
import { BASIC_REPO, EMPTY_REPO, TEST_ENV_NAMED as TEST_ENV } from "../fixtures";
import { createTestBash, quickExec, runScenario, setupSummaryHistory } from "../util";

describe("git show", () => {
	describe("outside a git repo", () => {
		test("fails with exit 128", async () => {
			const result = await quickExec("git show", { files: EMPTY_REPO });
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});
	});

	describe("no commits", () => {
		test("fails with exit 128", async () => {
			const { results } = await runScenario(["git init", "git show"], {
				files: EMPTY_REPO,
			});
			expect(results[1].exitCode).toBe(128);
			expect(results[1].stderr).toContain("does not have any commits yet");
		});
	});

	describe("bad revision", () => {
		test("fails with exit 128 for nonexistent ref", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "first"', "git show nonexistent"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			expect(results[3].exitCode).toBe(128);
			expect(results[3].stderr).toContain("bad object");
		});
	});

	describe("show commit (default HEAD)", () => {
		test("shows commit header with hash, author, date, message", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial commit"', "git show"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toMatch(/commit [a-f0-9]{40}/);
			expect(show.stdout).toContain("Author: Test Author <author@test.com>");
			expect(show.stdout).toContain("Date:");
			expect(show.stdout).toContain("    initial commit");
		});

		test("includes diff against empty tree for root commit", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			// Should show the README.md being added
			expect(show.stdout).toContain("diff --git a/README.md b/README.md");
			expect(show.stdout).toContain("new file mode");
			expect(show.stdout).toContain("+# My Project");
		});

		test("includes diff against parent for non-root commit", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "add main"');

			const show = await bash.exec("git show");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("    add main");
			expect(show.stdout).toContain("diff --git a/src/main.ts b/src/main.ts");
			expect(show.stdout).toContain("new file mode");
			// Should NOT contain README.md diff (that was in first commit)
			expect(show.stdout).not.toContain("diff --git a/README.md b/README.md");
		});
	});

	describe("show commit by hash", () => {
		test("shows specific commit when given a full hash", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "first"');
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "second"');

			// Extract the full hash of the first commit from git log
			const log = await bash.exec("git log");
			const hashes = [...log.stdout.matchAll(/commit ([a-f0-9]{40})/g)].map((m) => m[1] as string);
			const firstHash = hashes[1] as string; // second in log = first chronologically

			const show = await bash.exec(`git show ${firstHash}`);
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("    first");
			expect(show.stdout).toContain("diff --git a/README.md b/README.md");
		});
	});

	describe("show merge commit", () => {
		test("shows Merge line and no diff for merge commits", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add README.md");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git checkout -b feature");
			await bash.exec("git add src/main.ts");
			await bash.exec('git commit -m "feature work"');

			await bash.exec("git checkout main");
			await bash.exec("git add src/util.ts");
			await bash.exec('git commit -m "main work"');

			await bash.exec("git merge --no-ff feature");

			const show = await bash.exec("git show");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("Merge:");
			// Merge commits should NOT include diff output
			expect(show.stdout).not.toContain("diff --git");
		});

		test("stat formats compare a merge with its first parent", async () => {
			const bash = await setupSummaryHistory();
			const cases: [string, string][] = [
				["--stat", " s | 1 +\n 1 file changed, 1 insertion(+)\n"],
				["--shortstat", " 1 file changed, 1 insertion(+)\n"],
				["--numstat", "1\t0\ts\n"],
			];
			for (const [opts, diff] of cases) {
				expect(await bash.exec(`git show ${opts} --format=%s HEAD`)).toMatchObject({
					stdout: `merge side\n\n${diff}`,
					stderr: "",
					exitCode: 0,
				});
			}
		});
	});

	describe("show annotated tag", () => {
		test("shows tag info then commit info", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec('git tag -a v1.0 -m "release 1.0"');

			const show = await bash.exec("git show v1.0");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("tag v1.0");
			expect(show.stdout).toContain("Tagger: Test Committer <committer@test.com>");
			expect(show.stdout).toContain("    release 1.0");
			// Should also show the commit
			expect(show.stdout).toMatch(/commit [a-f0-9]{40}/);
			expect(show.stdout).toContain("    initial");
			// And the commit's diff
			expect(show.stdout).toContain("diff --git a/README.md b/README.md");
		});
	});

	describe("show lightweight tag", () => {
		test("resolves to commit and shows commit", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			await bash.exec("git tag v1.0");

			const show = await bash.exec("git show v1.0");
			expect(show.exitCode).toBe(0);
			// Lightweight tag points directly to commit, no tag header
			expect(show.stdout).not.toContain("tag v1.0");
			expect(show.stdout).toMatch(/commit [a-f0-9]{40}/);
			expect(show.stdout).toContain("    initial");
		});
	});

	describe("show tree object", () => {
		test("lists tree entries", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Get the full commit hash
			const log = await bash.exec("git log");
			const commitHash = (
				log.stdout.match(/commit ([a-f0-9]{40})/) as RegExpMatchArray
			)[1] as string;

			// Extract tree hash from the object store
			const treeHash = await getTreeHash(bash, commitHash);
			if (!treeHash) throw new Error("Could not get tree hash");

			const treeShow = await bash.exec(`git show ${treeHash}`);
			expect(treeShow.exitCode).toBe(0);
			expect(treeShow.stdout).toContain("100644 blob");
			expect(treeShow.stdout).toContain("README.md");
			expect(treeShow.stdout).toContain("040000 tree");
			expect(treeShow.stdout).toContain("src");
		});
	});

	describe("show blob object", () => {
		test("prints raw blob content", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Get full commit hash
			const log = await bash.exec("git log");
			const commitHash = (
				log.stdout.match(/commit ([a-f0-9]{40})/) as RegExpMatchArray
			)[1] as string;

			const treeHash = await getTreeHash(bash, commitHash);
			if (!treeHash) throw new Error("Could not get tree hash");

			// Read tree to find README.md blob hash
			const treeShow = await bash.exec(`git show ${treeHash}`);
			// Parse "100644 blob <hash>\tREADME.md"
			const match = treeShow.stdout.match(/100644 blob ([a-f0-9]{40})\tREADME\.md/);
			expect(match).toBeTruthy();
			const blobHash = match?.[1] as string;

			const blobShow = await bash.exec(`git show ${blobHash}`);
			expect(blobShow.exitCode).toBe(0);
			expect(blobShow.stdout).toBe("# My Project");
		});
	});

	describe("output format flags", () => {
		test("--stat shows diffstat instead of patch", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --stat"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("    initial");
			expect(show.stdout).toContain("README.md");
			expect(show.stdout).toContain("3 files changed");
			expect(show.stdout).not.toContain("diff --git");
		});

		test("--name-only lists changed file names", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --name-only"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("README.md\n");
			expect(show.stdout).toContain("src/main.ts\n");
			expect(show.stdout).toContain("src/util.ts\n");
			expect(show.stdout).not.toContain("diff --git");
		});

		test("--name-status lists names with status letters", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --name-status"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("A\tREADME.md");
			expect(show.stdout).toContain("A\tsrc/main.ts");
			expect(show.stdout).not.toContain("diff --git");
		});

		test("-p shows patch (same as default)", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show -p"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("diff --git");
		});

		test("--no-patch suppresses diff output", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --no-patch"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("    initial");
			expect(show.stdout).toContain("Author:");
			expect(show.stdout).not.toContain("diff --git");
			expect(show.stdout).not.toContain("files changed");
		});

		test("--shortstat shows only summary line", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --shortstat"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("3 files changed, 3 insertions(+)");
			expect(show.stdout).not.toContain("diff --git");
		});

		test("--numstat shows machine-readable insertions/deletions", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --numstat"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("1\t0\tREADME.md");
			expect(show.stdout).toContain("1\t0\tsrc/main.ts");
			expect(show.stdout).not.toContain("diff --git");
		});
	});

	describe("--format and --pretty", () => {
		test("--format=%H shows only the full hash", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --format=%H --no-patch"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
		});

		test("--format=%s shows subject line", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --format=%s --no-patch"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout.trim()).toBe("initial");
		});

		test("--pretty=oneline shows hash + subject on one line", async () => {
			const { results } = await runScenario(
				[
					"git init",
					"git add .",
					'git commit -m "initial"',
					"git show --pretty=oneline --no-patch",
				],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout.trim()).toMatch(/^[a-f0-9]{40} initial$/);
		});

		test("--pretty=short shows author without date", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --pretty=short --no-patch"],
				{ files: EMPTY_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("Author:");
			expect(show.stdout).not.toContain("Date:");
		});

		test("--format with --stat shows formatted header + diffstat", async () => {
			const { results } = await runScenario(
				["git init", "git add .", 'git commit -m "initial"', "git show --format=%s --stat"],
				{ files: BASIC_REPO, env: TEST_ENV },
			);
			const show = results[3];
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("initial");
			expect(show.stdout).toContain("3 files changed");
			expect(show.stdout).not.toContain("diff --git");
		});
	});

	describe("show with modified files", () => {
		test("diff shows modifications correctly", async () => {
			const bash = createTestBash({ files: EMPTY_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			// Modify the file
			bash.fs.writeFile("/repo/README.md", "# Updated Project\n\nNew content\n");
			await bash.exec("git add .");
			await bash.exec('git commit -m "update readme"');

			const show = await bash.exec("git show");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("    update readme");
			expect(show.stdout).toContain("-# My Project");
			expect(show.stdout).toContain("+# Updated Project");
		});

		test("diff shows deleted files", async () => {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');

			await bash.exec("git rm src/util.ts");
			await bash.exec('git commit -m "remove util"');

			const show = await bash.exec("git show");
			expect(show.exitCode).toBe(0);
			expect(show.stdout).toContain("deleted file mode");
			expect(show.stdout).toContain("diff --git a/src/util.ts b/src/util.ts");
		});
	});

	describe("--quiet", () => {
		async function setup() {
			const bash = createTestBash({ files: BASIC_REPO, env: TEST_ENV });
			await bash.exec("git init");
			await bash.exec("git add .");
			await bash.exec('git commit -m "initial"');
			return bash;
		}

		test("-q suppresses the default patch", async () => {
			const bash = await setup();
			const quiet = await bash.exec("git show -q");
			const noPatch = await bash.exec("git show --no-patch");
			expect(quiet.exitCode).toBe(0);
			expect(quiet.stdout).toBe(noPatch.stdout);
			expect(quiet.stdout).not.toContain("diff --git");
			expect(quiet.stdout).toEndWith("    initial\n");
		});

		test("--quiet with a custom format prints only the format", async () => {
			const bash = await setup();
			const result = await bash.exec("git show --quiet --format=%s");
			expect(result).toMatchObject({ stdout: "initial\n", stderr: "", exitCode: 0 });
		});

		test("--no-quiet after -q restores the patch", async () => {
			const bash = await setup();
			const result = await bash.exec("git show -q --no-quiet");
			const plain = await bash.exec("git show");
			expect(result.stdout).toBe(plain.stdout);
			expect(result.stdout).toContain("diff --git");
		});

		test("explicit diff formats still print", async () => {
			const bash = await setup();
			for (const opts of ["-p", "--stat", "--numstat", "--shortstat"]) {
				const quiet = await bash.exec(`git show -q ${opts}`);
				const plain = await bash.exec(`git show ${opts}`);
				expect(quiet.stdout).toBe(plain.stdout);
			}
			const patchFirst = await bash.exec("git show -p -q");
			expect(patchFirst.stdout).toContain("diff --git");
		});

		test("conflicts with --name-only and --name-status", async () => {
			const bash = await setup();
			for (const cmd of [
				"git show -q --name-only",
				"git show --name-status --quiet",
				"git show -q --name-only HEAD:README.md",
			]) {
				const result = await bash.exec(cmd);
				expect(result).toMatchObject({
					stdout: "",
					stderr:
						"fatal: options '--name-only', '--name-status', '--check', and '-s' cannot be used together\n",
					exitCode: 128,
				});
			}
		});

		test("revision errors take precedence over the conflict", async () => {
			const bash = await setup();
			const result = await bash.exec("git show -q --name-only HEAD:nope");
			expect(result.stderr).toBe("fatal: path 'nope' does not exist in 'HEAD'\n");
			expect(result.exitCode).toBe(128);
		});

		test("blobs and annotated tags", async () => {
			const bash = await setup();
			const blob = await bash.exec("git show -q HEAD:README.md");
			expect(blob.stdout).toBe("# My Project");

			await bash.exec("git tag -a v1 -m release");
			const tag = await bash.exec("git show -q v1");
			expect(tag.exitCode).toBe(0);
			expect(tag.stdout).toStartWith("tag v1\n");
			expect(tag.stdout).toEndWith("    initial\n");
			expect(tag.stdout).not.toContain("diff --git");
		});
	});

	describe("--summary", () => {
		const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });

		test("replaces the patch with the summary lines", async () => {
			const bash = await setupSummaryHistory();
			const header = (await bash.exec("git show --no-patch HEAD~5")).stdout;
			expect(await bash.exec("git show --summary HEAD~5")).toMatchObject(
				ok(
					`${header}\n` +
						" delete mode 100755 m\n" +
						" create mode 100644 n\n" +
						" rename z => z2 (100%)\n",
				),
			);
		});

		test("follows --stat", async () => {
			const bash = await setupSummaryHistory();
			expect(await bash.exec("git show --stat --summary --format=%s HEAD~4")).toMatchObject(
				ok(
					"modes\n\n" +
						" big => big2 | 5 -----\n" +
						" n           | 0\n" +
						" 2 files changed, 5 deletions(-)\n" +
						" rename big => big2 (70%)\n" +
						" mode change 100644 => 100755\n" +
						" mode change 100644 => 100755 n\n",
				),
			);
		});

		test("follows --shortstat and --numstat", async () => {
			const bash = await setupSummaryHistory();
			const summary = " delete mode 100755 m\n create mode 100644 n\n rename z => z2 (100%)\n";
			expect(await bash.exec("git show --shortstat --summary --format=%s HEAD~5")).toMatchObject(
				ok(`sum\n\n 3 files changed, 1 insertion(+), 1 deletion(-)\n${summary}`),
			);
			expect(await bash.exec("git show --numstat --summary --format=%s HEAD~5")).toMatchObject(
				ok(`sum\n\n0\t1\tm\n1\t0\tn\n0\t0\tz => z2\n${summary}`),
			);
		});

		test("comes before the patch with -p, separated by a blank line", async () => {
			const bash = await setupSummaryHistory();
			const patch = (await bash.exec("git show -p --format=%s HEAD~5")).stdout;
			expect(patch).toStartWith("sum\n\ndiff --git a/m b/m\n");
			expect(await bash.exec("git show -p --summary --format=%s HEAD~5")).toMatchObject(
				ok(
					"sum\n\n" +
						" delete mode 100755 m\n" +
						" create mode 100644 n\n" +
						" rename z => z2 (100%)\n" +
						"\n" +
						patch.slice("sum\n\n".length),
				),
			);
		});

		test("prints symlinks, quoted names and renames with a common prefix", async () => {
			const bash = await setupSummaryHistory();
			expect(await bash.exec("git show --summary --format=%s HEAD~3")).toMatchObject(
				ok(
					"more\n\n" +
						" rename dir/sub/{a => b} (100%)\n" +
						" create mode 120000 link\n" +
						' create mode 100644 "q\\"uote"\n' +
						" create mode 100644 sp ace\n" +
						' create mode 100644 "ta\\tb"\n' +
						' create mode 100644 "\\303\\251.txt"\n',
				),
			);
		});

		test("prints a type change as a mode change", async () => {
			const bash = await setupSummaryHistory();
			expect(await bash.exec("git show --summary --format=%s HEAD~2")).toMatchObject(
				ok(
					"typechange\n\n" +
						" mode change 100755 => 120000 n\n" +
						" rename {dir/sub => x/y}/b (100%)\n",
				),
			);
		});

		test("keeps the blank line when a commit has no summary lines", async () => {
			const bash = await setupSummaryHistory();
			const header = (await bash.exec("git show --no-patch HEAD~1")).stdout;
			expect(await bash.exec("git show --summary HEAD~1")).toMatchObject(ok(`${header}\n`));
			expect(await bash.exec("git show --summary --format=%s HEAD~1")).toMatchObject(
				ok("content only\n\n"),
			);
		});

		test("is dropped by --name-only, --name-status and --no-patch", async () => {
			const bash = await setupSummaryHistory();
			for (const opts of ["--name-only", "--name-status", "--no-patch"]) {
				const plain = await bash.exec(`git show ${opts} HEAD~5`);
				expect(await bash.exec(`git show ${opts} --summary HEAD~5`)).toMatchObject(
					ok(plain.stdout),
				);
			}
		});

		test("compares a merge with its first parent", async () => {
			const bash = await setupSummaryHistory();
			const header = (await bash.exec("git show --no-patch HEAD")).stdout;
			expect(await bash.exec("git show --summary HEAD")).toMatchObject(
				ok(`${header}\n create mode 100644 s\n`),
			);
			expect(await bash.exec("git show --stat --summary --format=%s HEAD")).toMatchObject(
				ok("merge side\n\n s | 1 +\n 1 file changed, 1 insertion(+)\n create mode 100644 s\n"),
			);
		});

		test("applies to the commit an annotated tag points at", async () => {
			const bash = await setupSummaryHistory();
			await bash.exec("git tag -a v1 -m release HEAD~5");
			const result = await bash.exec("git show --summary v1");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toStartWith("tag v1\n");
			expect(result.stdout).toEndWith(
				"    sum\n\n delete mode 100755 m\n create mode 100644 n\n rename z => z2 (100%)\n",
			);
		});

		test("respects pathspecs, and a commit that doesn't touch them prints nothing", async () => {
			const bash = await setupSummaryHistory();
			expect(await bash.exec("git show --summary --format=%s HEAD~2 -- dir")).toMatchObject(
				ok("typechange\n\n delete mode 100644 dir/sub/b\n"),
			);
			expect(await bash.exec("git show --summary --format=%s HEAD~5 -- z2")).toMatchObject(
				ok("sum\n\n create mode 100644 z2\n"),
			);
			expect(
				await bash.exec("mkdir dir && cd dir && git show --summary --format=%s HEAD~2 -- ."),
			).toMatchObject(ok("typechange\n\n delete mode 100644 dir/sub/b\n"));
			for (const opts of ["--summary", "--stat", "-p", "--no-patch"]) {
				expect(await bash.exec(`git show ${opts} HEAD~1 -- dir`)).toMatchObject(ok(""));
			}
			// A merge that matches one of its parents in the paths is not shown either.
			expect(await bash.exec("git show --stat HEAD -- s")).toMatchObject(ok(""));
			expect(await bash.exec("git show HEAD -- keep")).toMatchObject(ok(""));
		});

		test("a tag whose commit doesn't touch the pathspec shows only the tag", async () => {
			const bash = await setupSummaryHistory();
			await bash.exec("git tag -a v1 -m release HEAD~1");
			const result = await bash.exec("git show --summary v1 -- dir");
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toStartWith("tag v1\n");
			expect(result.stdout).toEndWith("release\n");
			expect(result.stdout).not.toContain("commit ");
		});
	});
});

// ── Helpers ─────────────────────────────────────────────────────────

async function getTreeHash(
	bash: ReturnType<typeof createTestBash>,
	commitHash: string,
): Promise<string | null> {
	const { inflate } = await import("../../src/lib/pack/zlib");
	const prefix = commitHash.slice(0, 2);
	const rest = commitHash.slice(2);
	const objPath = `/repo/.git/objects/${prefix}/${rest}`;
	const raw = await bash.fs.readFileBuffer(objPath);
	const data = await inflate(raw);

	const nullIdx = data.indexOf(0);
	const content = new TextDecoder().decode(data.subarray(nullIdx + 1));
	const treeLine = content.split("\n").find((l) => l.startsWith("tree "));
	if (!treeLine) return null;
	return treeLine.slice(5);
}
