// Evidence report: how deeply does `CommandResult` (the CLI command
// stdout/stderr/exitCode contract) still permeate `src/lib`?
//
// The ultimate goal is for `CommandResult` to be owned by the `cli` layer, so
// `lib` has no concept of it — lib functions would surface typed errors instead
// of pre-baked command output. This report surfaces the current lib footprint
// on two levels:
//
//   1. Imports  — which lib files import CommandResult / its helpers, split by
//      role: speaks-the-type (`CommandResult`), produces values (`err`/`fatal`/
//      `ambiguousArgError`), or branches on it (`isCommandError`).
//   2. Signatures — which lib functions actually have CommandResult in their
//      signature (return or param), resolved through the checker so implicit
//      `return fatal(...)` returns count too. This is the concrete refactor
//      surface: every one of these must change to stop speaking CommandResult.
//
// Regenerate with `bun scripts/lib-command-result.ts`.

import {
	buildImportGraph,
	functionsReferencingType,
	parentDir,
	symbolEdges,
} from "../test/introspection/index.ts";

const line = (s = "") => console.log(s);
const HELPERS_PRODUCE = new Set(["err", "fatal", "ambiguousArgError"]);
const CMD_ERRORS = "commands/kit/command-result.ts";

line("# CommandResult footprint in src/lib\n");

// ── 1. Import-level footprint ────────────────────────────────────────────────
const graph = await buildImportGraph({ include: "src", root: "src" });
const edges = symbolEdges(graph).filter(
	(s) => s.fromRel.startsWith("lib/") && s.toRel === CMD_ERRORS,
);

const byFile = new Map<string, { type: string[]; produce: string[]; branch: string[] }>();
for (const s of edges) {
	const rec = byFile.get(s.fromRel) ?? { type: [], produce: [], branch: [] };
	if (s.importedName === "CommandResult") rec.type.push(s.importedName);
	else if (HELPERS_PRODUCE.has(s.importedName)) rec.produce.push(s.importedName);
	else if (s.importedName === "isCommandError") rec.branch.push(s.importedName);
	byFile.set(s.fromRel, rec);
}

const dirCount = new Map<string, number>();
for (const f of byFile.keys()) dirCount.set(parentDir(f), (dirCount.get(parentDir(f)) ?? 0) + 1);

line(
	`## imports — ${byFile.size} lib files depend on ${CMD_ERRORS} ` +
		`(${[...dirCount.entries()].map(([d, n]) => `${d}:${n}`).join("  ")})\n`,
);
line(`  ${"lib file".padEnd(32)}${"speaks-type".padEnd(15)}${"produces".padEnd(16)}branches-on`);
for (const [file, rec] of [...byFile.entries()].sort()) {
	line(
		`  ${file.padEnd(32)}${(rec.type.length ? "CommandResult" : "").padEnd(15)}` +
			`${rec.produce.join(",").padEnd(16)}${rec.branch.join(",")}`,
	);
}

// ── 2. Signature-level footprint (the refactor surface) ──────────────────────
const refs = (
	await functionsReferencingType({ include: "src/lib", root: "src" }, ["CommandResult"])
)
	.filter((r) => r.relPath.startsWith("lib/"))
	.sort((a, b) => a.id.localeCompare(b.id));

const returns = refs.filter((r) => r.positions.includes("return"));
const params = refs.filter((r) => r.positions.includes("param"));
const sigFiles = new Set(refs.map((r) => r.relPath));

line(
	`\n## signatures — ${refs.length} lib functions have CommandResult in their signature ` +
		`across ${sigFiles.size} files (${returns.length} return it, ${params.length} take it)\n`,
);

const byFileRefs = new Map<string, typeof refs>();
for (const r of refs) {
	const l = byFileRefs.get(r.relPath) ?? [];
	l.push(r);
	byFileRefs.set(r.relPath, l);
}
for (const [file, list] of [...byFileRefs.entries()].sort((a, b) => b[1].length - a[1].length)) {
	line(`  ${file}  (${list.length})`);
	for (const r of list) {
		const pos = r.positions.sort().join("+");
		line(`      ${r.exported ? "" : "· "}${r.name}  [${pos}]`);
	}
}
line("\n  (· = non-exported / file-local)");
