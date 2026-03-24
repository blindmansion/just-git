import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { createGit } from "../../src/index.ts";
import { createServer } from "../../src/server/handler.ts";
import { MemoryStorage } from "../../src/server/memory-storage.ts";
import type { GitServer } from "../../src/server/types.ts";

const ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
	GIT_AUTHOR_DATE: "1000000000",
	GIT_COMMITTER_DATE: "1000000000",
};

function envAt(ts: number) {
	return { ...ENV, GIT_AUTHOR_DATE: String(ts), GIT_COMMITTER_DATE: String(ts) };
}

const BASE = "http://git";

function setup() {
	const server = createServer({ storage: new MemoryStorage(), autoCreate: true });
	return server;
}

function seedClient(server: GitServer) {
	const fs = new InMemoryFs();
	const git = createGit({ network: server.asNetwork(BASE) });
	return new Bash({ fs, cwd: "/", customCommands: [git] });
}

async function seedRepo(server: GitServer) {
	const seeder = seedClient(server);
	await seeder.exec(`git clone ${BASE}/repo /seed`, { env: envAt(1000000000) });
	await seeder.writeFile("/seed/README.md", "# Hello");
	await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000000) });
	await seeder.exec('git commit -m "init"', { cwd: "/seed", env: envAt(1000000000) });
	await seeder.exec("git push origin main", { cwd: "/seed" });
	return seeder;
}

describe("credential sanitization", () => {
	describe("git remote add", () => {
		test("strips credentials from stored URL", async () => {
			const fs = new InMemoryFs();
			const git = createGit();
			const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");

			await bash.exec("git remote add origin https://user:secret@github.com/org/repo.git");

			const config = await fs.readFile("/repo/.git/config");
			expect(config).toContain("url = https://github.com/org/repo.git");
			expect(config).not.toContain("user");
			expect(config).not.toContain("secret");
		});

		test("git remote -v shows sanitized URL", async () => {
			const fs = new InMemoryFs();
			const git = createGit();
			const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");

			await bash.exec("git remote add origin https://token:x-oauth@example.com/repo.git");

			const result = await bash.exec("git remote -v");
			expect(result.stdout).toContain("https://example.com/repo.git");
			expect(result.stdout).not.toContain("token");
			expect(result.stdout).not.toContain("x-oauth");
		});

		test("git remote get-url shows sanitized URL", async () => {
			const fs = new InMemoryFs();
			const git = createGit();
			const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");

			await bash.exec("git remote add origin https://user:pass@example.com/repo.git");

			const result = await bash.exec("git remote get-url origin");
			expect(result.stdout.trim()).toBe("https://example.com/repo.git");
		});
	});

	describe("git remote set-url", () => {
		test("strips credentials when updating URL", async () => {
			const fs = new InMemoryFs();
			const git = createGit();
			const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");

			await bash.exec("git remote set-url origin https://user:newpass@example.com/repo.git");

			const config = await fs.readFile("/repo/.git/config");
			expect(config).toContain("url = https://example.com/repo.git");
			expect(config).not.toContain("user");
			expect(config).not.toContain("newpass");
		});

		test("git remote -v shows sanitized URL after set-url", async () => {
			const fs = new InMemoryFs();
			const git = createGit();
			const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");
			await bash.exec("git remote set-url origin https://token:secret@example.com/repo.git");

			const result = await bash.exec("git remote -v");
			expect(result.stdout).toContain("https://example.com/repo.git");
			expect(result.stdout).not.toContain("token");
			expect(result.stdout).not.toContain("secret");
		});

		test("git remote get-url shows sanitized URL after set-url", async () => {
			const fs = new InMemoryFs();
			const git = createGit();
			const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");
			await bash.exec("git remote add origin https://example.com/repo.git");
			await bash.exec("git remote set-url origin https://user:pass@example.com/new-repo.git");

			const result = await bash.exec("git remote get-url origin");
			expect(result.stdout.trim()).toBe("https://example.com/new-repo.git");
		});
	});

	describe("git clone", () => {
		test("stores sanitized URL in config after clone", async () => {
			const server = setup();
			await seedRepo(server);

			const fs = new InMemoryFs();
			const git = createGit({
				network: server.asNetwork(BASE),
			});
			const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

			const result = await bash.exec(`git clone http://user:token@git/repo /work`, {
				env: envAt(1000000100),
			});
			expect(result.exitCode).toBe(0);

			const config = await fs.readFile("/work/.git/config");
			expect(config).toContain("url = http://git/repo");
			expect(config).not.toContain("user:token");
			expect(config).not.toContain("token");
		});

		test("FETCH_HEAD does not contain credentials after clone", async () => {
			const server = setup();
			await seedRepo(server);

			const fs = new InMemoryFs();
			const git = createGit({
				network: server.asNetwork(BASE),
			});
			const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

			await bash.exec(`git clone http://user:secret@git/repo /work`, { env: envAt(1000000100) });

			const fetchHead = await fs.readFile("/work/.git/FETCH_HEAD").catch(() => "");
			expect(fetchHead).not.toContain("secret");
			expect(fetchHead).not.toContain("user:secret");
		});
	});

	describe("clone then fetch/push/pull via cached credentials", () => {
		test("push works after clone with embedded credentials", async () => {
			const server = setup();
			await seedRepo(server);

			const fs = new InMemoryFs();
			const git = createGit({
				network: server.asNetwork(BASE),
			});
			const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

			await bash.exec(`git clone http://user:token@git/repo /work`, { env: envAt(1000000100) });

			await bash.writeFile("/work/new.txt", "new content");
			await bash.exec("git add .", { cwd: "/work", env: envAt(1000000200) });
			await bash.exec('git commit -m "add file"', { cwd: "/work", env: envAt(1000000200) });

			const pushResult = await bash.exec("git push origin main", { cwd: "/work" });
			expect(pushResult.exitCode).toBe(0);
		});

		test("fetch works after clone with embedded credentials", async () => {
			const server = setup();
			const seeder = await seedRepo(server);

			const fs = new InMemoryFs();
			const git = createGit({
				network: server.asNetwork(BASE),
			});
			const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

			await bash.exec(`git clone http://user:token@git/repo /work`, { env: envAt(1000000100) });

			await seeder.writeFile("/seed/extra.txt", "more");
			await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000200) });
			await seeder.exec('git commit -m "more"', { cwd: "/seed", env: envAt(1000000200) });
			await seeder.exec("git push origin main", { cwd: "/seed" });

			const fetchResult = await bash.exec("git fetch origin", { cwd: "/work" });
			expect(fetchResult.exitCode).toBe(0);
		});

		test("pull works after clone with embedded credentials", async () => {
			const server = setup();
			const seeder = await seedRepo(server);

			const fs = new InMemoryFs();
			const git = createGit({
				network: server.asNetwork(BASE),
			});
			const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

			await bash.exec(`git clone http://user:token@git/repo /work`, { env: envAt(1000000100) });

			await seeder.writeFile("/seed/extra.txt", "pulled content");
			await seeder.exec("git add .", { cwd: "/seed", env: envAt(1000000200) });
			await seeder.exec('git commit -m "more"', { cwd: "/seed", env: envAt(1000000200) });
			await seeder.exec("git push origin main", { cwd: "/seed" });

			const pullResult = await bash.exec("git pull origin main", {
				cwd: "/work",
				env: envAt(1000000300),
			});
			expect(pullResult.exitCode).toBe(0);

			const content = await fs.readFile("/work/extra.txt");
			expect(content).toBe("pulled content");
		});
	});

	describe("remote add then fetch/push via cached credentials", () => {
		test("fetch works after remote add with embedded credentials", async () => {
			const server = setup();
			await seedRepo(server);

			const fs = new InMemoryFs();
			const git = createGit({
				network: server.asNetwork(BASE),
			});
			const bash = new Bash({ fs, cwd: "/work", customCommands: [git] });

			await bash.exec("git init", { env: envAt(1000000100) });
			await bash.exec("git remote add origin http://user:token@git/repo");

			const fetchResult = await bash.exec("git fetch origin");
			expect(fetchResult.exitCode).toBe(0);
		});

		test("push works after remote add with embedded credentials", async () => {
			const server = setup();
			await seedRepo(server);

			const fs = new InMemoryFs();
			const git = createGit({
				network: server.asNetwork(BASE),
			});
			const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

			await bash.exec(`git clone ${BASE}/repo /work`, { env: envAt(1000000100) });
			await bash.exec("git remote set-url origin http://user:token@git/repo", { cwd: "/work" });

			await bash.writeFile("/work/new.txt", "content");
			await bash.exec("git add .", { cwd: "/work", env: envAt(1000000200) });
			await bash.exec('git commit -m "via set-url creds"', {
				cwd: "/work",
				env: envAt(1000000200),
			});

			const pushResult = await bash.exec("git push origin main", { cwd: "/work" });
			expect(pushResult.exitCode).toBe(0);
		});
	});

	describe("credentials callback takes precedence", () => {
		test("credential provider wins over cached URL credentials", async () => {
			const server = setup();
			await seedRepo(server);

			let calledWith = "";
			const fs = new InMemoryFs();
			const git = createGit({
				network: server.asNetwork(BASE),
				credentials: (url) => {
					calledWith = url;
					return { type: "bearer", token: "callback-token" };
				},
			});
			const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

			await bash.exec(`git clone http://user:embedded@git/repo /work`, { env: envAt(1000000100) });

			expect(calledWith).toBe("http://git/repo");
			expect(calledWith).not.toContain("user");
			expect(calledWith).not.toContain("embedded");
		});
	});

	describe("hook events receive sanitized URLs", () => {
		test("preClone and postClone receive sanitized repository URL", async () => {
			const server = setup();
			await seedRepo(server);

			const urls: string[] = [];
			const fs = new InMemoryFs();
			const git = createGit({
				network: server.asNetwork(BASE),
				hooks: {
					preClone: (event) => {
						urls.push(event.repository);
					},
					postClone: (event) => {
						urls.push(event.repository);
					},
				},
			});
			const bash = new Bash({ fs, cwd: "/", customCommands: [git] });

			await bash.exec(`git clone http://user:secret@git/repo /work`, { env: envAt(1000000100) });

			expect(urls).toHaveLength(2);
			for (const url of urls) {
				expect(url).not.toContain("user");
				expect(url).not.toContain("secret");
				expect(url).toContain("git/repo");
			}
		});
	});

	describe("non-HTTP URLs pass through unchanged", () => {
		test("local path remote add is not affected", async () => {
			const fs = new InMemoryFs();
			const git = createGit();
			const bash = new Bash({ fs, cwd: "/repo", customCommands: [git] });
			await bash.exec("git init");

			await bash.exec("git remote add origin /some/local/path");

			const result = await bash.exec("git remote get-url origin");
			expect(result.stdout.trim()).toBe("/some/local/path");
		});
	});
});
