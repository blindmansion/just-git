import type { CommandContext, GitExtensions } from "../git.ts";
import { WM_MATCH, wildmatch } from "../lib/attributes/wildmatch.ts";
import type { DiffStats, FileStat, ModeChange } from "../lib/commit-summary.ts";
import { renderDiffStat, renderModeLine } from "../lib/diff/stat-format.ts";
import {
	type ApplyResult,
	type ApplyTarget,
	applyPatches,
	type WhitespaceAction,
} from "../lib/patch/apply.ts";
import { ApplyParseError, type ParsedPatch, parsePatch } from "../lib/patch/parse-patch.ts";
import { resolve } from "../lib/path.ts";
import { fatal, isCommandError } from "./kit/command-result.ts";
import { requireGitContext } from "./kit/commit-requirements.ts";
import { a, type Command, f, o } from "./kit/parse/index.ts";

/** Decode a possibly-byte-encoded stdin payload into text (see check-attr). */
function stdinToText(stdin: CommandContext["stdin"]): string {
	const raw = stdin as string;
	if (typeof raw !== "string") return "";
	for (let i = 0; i < raw.length; i++) {
		if (raw.charCodeAt(i) > 255) return raw;
	}
	const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return raw;
	}
}

/** Format a numeric git mode as its 6-digit octal string (e.g. `100644`). */
function modeStr(mode: number | undefined): string {
	return (mode ?? 0o100644).toString(8).padStart(6, "0");
}

function patchPath(p: ParsedPatch): string {
	return p.newName ?? p.oldName ?? "";
}

/** Build the diffstat structures git's `--stat` renders from parsed patches. */
function toDiffStats(patches: ParsedPatch[]): DiffStats {
	const fileStats: FileStat[] = [];
	const modeChanges: ModeChange[] = [];
	for (const p of patches) {
		const path = patchPath(p);
		fileStats.push({
			path,
			sortKey: path,
			insertions: p.linesAdded,
			deletions: p.linesDeleted,
			isBinary: p.isBinary,
			rename:
				p.kind === "rename" && p.oldName && p.newName
					? { oldPath: p.oldName, newPath: p.newName }
					: undefined,
		});
		if (p.kind === "new") {
			modeChanges.push({ kind: "create", mode: modeStr(p.newMode), path });
		} else if (p.kind === "delete") {
			modeChanges.push({ kind: "delete", mode: modeStr(p.oldMode), path: p.oldName ?? path });
		} else if (p.kind === "rename" && p.oldName && p.newName) {
			modeChanges.push({
				kind: "rename",
				oldPath: p.oldName,
				newPath: p.newName,
				similarity: p.score ?? 100,
			});
		} else if (p.oldMode && p.newMode && p.oldMode !== p.newMode) {
			modeChanges.push({
				kind: "modechange",
				oldMode: modeStr(p.oldMode),
				newMode: modeStr(p.newMode),
				path,
			});
		}
	}
	return { fileStats, modeChanges };
}

/** `--numstat`: `added<TAB>deleted<TAB>path` (`-` counts for binary). */
function renderNumstat(patches: ParsedPatch[]): string {
	return patches
		.map((p) => {
			const path = patchPath(p);
			const display =
				p.kind === "rename" && p.oldName && p.newName ? `${p.oldName} => ${p.newName}` : path;
			return p.isBinary ? `-\t-\t${display}\n` : `${p.linesAdded}\t${p.linesDeleted}\t${display}\n`;
		})
		.join("");
}

/** `--summary`: the extended-header create/delete/rename/mode lines only. */
function renderSummary(patches: ParsedPatch[]): string {
	const { modeChanges } = toDiffStats(patches);
	return modeChanges.map((mc) => `${renderModeLine(mc)}\n`).join("");
}

/**
 * git's `use_patch`: decide whether a patch survives the `--include`/`--exclude`
 * filters. git keeps a single command-line-ordered rule list (first match wins);
 * with the flags split into two arrays we approximate that by letting an
 * `--include` match win over an `--exclude` match, then dropping anything that
 * matches no `--include` when includes were given at all.
 */
function usePatch(name: string, includes: string[], excludes: string[]): boolean {
	if (includes.some((pat) => wildmatch(pat, name, 0) === WM_MATCH)) return true;
	if (excludes.some((pat) => wildmatch(pat, name, 0) === WM_MATCH)) return false;
	return includes.length === 0;
}

/**
 * Render the non-fatal stderr git emits: per-hunk reject notices (`--reject`),
 * per-line whitespace warnings, and the end-of-run whitespace summary.
 */
function renderApplyStderr(
	result: ApplyResult,
	whitespace: WhitespaceAction,
	patchInputName: string,
): string {
	const lines: string[] = [];

	// `-3` / `--3way` per-file notices (git's try_threeway / apply_data). The
	// blob-missing error + "Falling back…" precede any hard `patch failed` error.
	for (const f of result.files) {
		const tw = f.threeway;
		if (!tw) continue;
		if (tw.kind === "clean") {
			lines.push(`Applied patch to '${f.path}' cleanly.`);
		} else if (tw.kind === "conflict") {
			lines.push(`Applied patch to '${f.path}' with conflicts.`);
		} else if (tw.kind === "fallback") {
			if (tw.note) lines.push(`error: ${tw.note}`);
			lines.push("Falling back to direct application...");
		}
	}

	// error: lines from the engine (hunk mismatch / binary / preconditions).
	for (const e of result.errors) lines.push(`error: ${e}`);

	// `--reject`: git still reports each failed hunk as an error, then lists the
	// per-hunk disposition while writing the `.rej` file.
	for (const f of result.files) {
		if (f.rejected.length === 0) continue;
		for (const frag of f.rejected) {
			lines.push(`error: patch failed: ${f.path}:${frag.oldStart}`);
		}
		const n = f.rejected.length;
		lines.push(`Applying patch ${f.path} with ${n} ${n === 1 ? "reject" : "rejects"}...`);
		f.fragmentResults.forEach((fr, i) => {
			lines.push(fr.applied ? `Hunk #${i + 1} applied cleanly.` : `Rejected hunk #${i + 1}.`);
		});
	}

	// Whitespace: per-line warnings (squelched after 5, unless error-all) plus a
	// closing summary (git's record_ws_error + apply_all_patches tail).
	if (whitespace !== "nowarn" && whitespace !== "fix") {
		const warnings = result.files.flatMap((f) => f.whitespace);
		const squelch = whitespace === "error-all" ? 0 : 5;
		warnings.forEach((w, i) => {
			if (squelch && i >= squelch) return;
			lines.push(`${patchInputName}:${w.patchLine}: ${w.message}.`);
			lines.push(w.content);
		});
		const total = warnings.length;
		if (total > 0) {
			if (squelch && squelch < total) {
				const sq = total - squelch;
				lines.push(`warning: squelched ${sq} whitespace ${sq === 1 ? "error" : "errors"}`);
			}
			const prefix = whitespace === "error" || whitespace === "error-all" ? "error" : "warning";
			const verb = total === 1 ? "line adds" : "lines add";
			lines.push(`${prefix}: ${total} ${verb} whitespace errors.`);
		}
	}

	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Normalize a `--whitespace=<action>` value; unknown values fall back to warn. */
function parseWhitespace(v: string | undefined): WhitespaceAction {
	switch (v) {
		case "nowarn":
		case "warn":
		case "fix":
		case "error":
		case "error-all":
			return v;
		default:
			return "warn";
	}
}

export function registerApplyCommand(parent: Command, ext?: GitExtensions): void {
	parent.command("apply", {
		description: "Apply a patch to files and/or to the index",
		// `-p<n>` strips leading path components; rewrite it to `--strip <n>` so
		// the parser doesn't treat it as an unknown short flag cluster.
		transformArgs: (tokens) =>
			tokens.flatMap((t) => {
				const m = /^-p(\d+)$/.exec(t);
				return m ? ["--strip", m[1] as string] : [t];
			}),
		args: [a.string().name("patches").variadic().optional()],
		options: {
			stat: f().describe("Instead of applying, output a diffstat for the input"),
			numstat: f().describe("Like --stat but in a machine-friendly format"),
			summary: f().describe("Output a condensed summary of extended header info"),
			check: f().describe("Check if the patch applies without applying it"),
			index: f().describe("Apply the patch to both the index and the working tree"),
			cached: f().describe("Apply the patch to the index without touching the working tree"),
			reverse: f().alias("R").describe("Apply the patch in reverse"),
			"3way": f().alias("3").describe("Fall back on 3-way merge if the patch does not apply"),
			reject: f().describe("Leave rejected hunks in .rej files instead of failing"),
			unidiffZero: f().describe("Do not trust the line counts in @@ headers with -U0 patches"),
			recount: f().describe("Recount hunk line counts from the body"),
			strip: o.number().default(1).describe("Strip <n> leading path components (-p<n>)"),
			whitespace: o
				.string()
				.describe("Action for whitespace errors (nowarn|warn|fix|error|error-all)"),
			directory: o.string().describe("Prepend <root> to all filenames"),
			include: o.string().repeatable().describe("Apply changes matching the given path pattern"),
			exclude: o.string().repeatable().describe("Ignore changes matching the given path pattern"),
		},
		handler: async (args, ctx) => {
			const gitCtxOrError = await requireGitContext(ctx.fs, ctx.cwd, ext);
			if (isCommandError(gitCtxOrError)) return gitCtxOrError;
			const gitCtx = gitCtxOrError;

			// ── Gather patch text (files, else stdin) ────────────────
			const files = (args.patches as string[] | undefined) ?? [];
			let text: string;
			if (files.length > 0) {
				const parts: string[] = [];
				for (const file of files) {
					const full = resolve(ctx.cwd, file);
					if (!(await ctx.fs.exists(full))) {
						return fatal(`can't open patch '${file}': No such file or directory`);
					}
					parts.push(new TextDecoder().decode(await ctx.fs.readFileBuffer(full)));
				}
				text = parts.join("");
			} else {
				text = stdinToText(ctx.stdin);
			}

			if (text.trim() === "") {
				return fatal("unrecognized input");
			}

			// ── Parse ────────────────────────────────────────────────
			const strip = (args.strip as number | undefined) ?? 1;
			let patches: ParsedPatch[];
			try {
				patches = parsePatch(text, strip, args.recount as boolean);
			} catch (e) {
				if (e instanceof ApplyParseError) {
					return { stdout: "", stderr: `error: corrupt patch at line ${e.line}\n`, exitCode: 1 };
				}
				throw e;
			}

			if (patches.length === 0) {
				return fatal("unrecognized input");
			}

			// Optional --directory prefix applied to every path.
			const dir = args.directory as string | undefined;
			if (dir) {
				const prefix = dir.endsWith("/") ? dir : `${dir}/`;
				for (const p of patches) {
					if (p.oldName) p.oldName = prefix + p.oldName;
					if (p.newName) p.newName = prefix + p.newName;
				}
			}

			// ── --include / --exclude filtering (git's use_patch) ─────
			const includes = (args.include as string[] | undefined) ?? [];
			const excludes = (args.exclude as string[] | undefined) ?? [];
			if (includes.length > 0 || excludes.length > 0) {
				patches = patches.filter((p) => usePatch(p.newName ?? p.oldName ?? "", includes, excludes));
				if (patches.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
			}

			// ── Info-only modes (no writes) ──────────────────────────
			if (args.numstat) return { stdout: renderNumstat(patches), stderr: "", exitCode: 0 };
			if (args.summary) return { stdout: renderSummary(patches), stderr: "", exitCode: 0 };
			if (args.stat) {
				return { stdout: renderDiffStat(toDiffStats(patches)), stderr: "", exitCode: 0 };
			}

			// ── Apply (or --check) ───────────────────────────────────
			// `--3way` implies index checking/updating (git's check_apply_state):
			// it reads the preimage from the index and writes both, and cannot be
			// combined with `--reject`.
			if (args["3way"] && args.reject) {
				return fatal("options '--reject' and '--3way' cannot be used together");
			}
			const target: ApplyTarget = args.cached
				? "cached"
				: args.index || args["3way"]
					? "index"
					: "worktree";
			const whitespace = parseWhitespace(args.whitespace as string | undefined);
			const result = await applyPatches(gitCtx, patches, {
				reverse: args.reverse as boolean,
				target,
				whitespace,
				unidiffZero: args.unidiffZero as boolean,
				reject: args.reject as boolean,
				threeway: args["3way"] as boolean,
				check: args.check as boolean,
			});

			const patchInputName = files[0] ?? "<stdin>";
			const stderr = renderApplyStderr(result, whitespace, patchInputName);
			return { stdout: "", stderr, exitCode: result.ok ? 0 : 1 };
		},
	});
}
