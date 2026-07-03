import type { FileSystem } from "../fs/index.ts";
import { join } from "./path.ts";

/**
 * Move a file or directory tree from `src` to `dest`.
 *
 * Routes to the backend's native {@link FileSystem.mv} when available (atomic
 * `rename` on a real disk; a cheap map re-key in memory). When a backend omits
 * `mv`, falls back to a recursive copy followed by removing the source.
 *
 * `dest` is the final path — callers resolve any "move into an existing
 * directory" semantics beforehand. Like the native backends, the destination's
 * parent directory is created if missing; git-specific policy (the
 * "already exists" guard, the missing-parent error) lives in the caller.
 */
export async function movePath(fs: FileSystem, src: string, dest: string): Promise<void> {
	if (fs.mv) {
		await fs.mv(src, dest);
		return;
	}
	await copyRecursive(fs, src, dest);
	await fs.rm(src, { recursive: true, force: true });
}

async function copyRecursive(fs: FileSystem, src: string, dest: string): Promise<void> {
	// Preserve symlinks verbatim when the backend models them; otherwise they
	// degrade to plain files (core.symlinks=false), which is acceptable.
	if (fs.lstat && fs.readlink && fs.symlink) {
		const linkStat = await fs.lstat(src);
		if (linkStat.isSymbolicLink) {
			await fs.symlink(await fs.readlink(src), dest);
			return;
		}
	}

	const stat = await fs.stat(src);
	if (stat.isDirectory) {
		await fs.mkdir(dest, { recursive: true });
		for (const name of await fs.readdir(src)) {
			await copyRecursive(fs, join(src, name), join(dest, name));
		}
	} else {
		await fs.mkdir(parentDir(dest), { recursive: true });
		await fs.writeFile(dest, await fs.readFileBuffer(src));
	}
}

function parentDir(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "/" : path.slice(0, i);
}
