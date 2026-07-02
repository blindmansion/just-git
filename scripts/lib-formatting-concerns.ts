// Evidence report: how permeated is string *formatting* across `src/lib`, and
// how tangled is it with *data* (retrieval/computation) concerns?
//
// Uses the concern classifier (test/introspection/concerns.ts). Each named
// function is tagged formatting / data / mixed / logic on two axes:
//   • formats     — produces human-readable string output
//   • handlesData — async/await (runtime data retrieval in this codebase)
//
// The command layer is pulled in too: commands are the presentation tier, so
// formatting they import from *data-primary* lib files is the coupling smell.
//
// Regenerate with `bun scripts/lib-formatting-concerns.ts`.

import {
	buildImportGraph,
	classifyConcerns,
	fileConcernProfiles,
	type FunctionConcern,
	parentDir,
	symbolEdges,
} from "../test/introspection/index.ts";

const line = (s = "") => console.log(s);
const pct = (n: number, d: number) => (d === 0 ? "0%" : `${Math.round((100 * n) / d)}%`);

// Root everything at `src` so concern ids (`lib/x.ts#fn`) line up with the
// import graph's symbol-edge ids across the lib↔commands boundary.
const concerns = await classifyConcerns({ include: ["src/lib", "src/commands"], root: "src" });
const libFns = concerns.filter((c) => c.relPath.startsWith("lib/"));

line("# formatting vs data concerns\n");

// ── 1. Overall distribution ──────────────────────────────────────────────────
const counts = { formatting: 0, data: 0, mixed: 0, logic: 0 };
for (const c of libFns) counts[c.kind]++;
const total = libFns.length;
line(`## src/lib — ${total} named functions\n`);
for (const k of ["formatting", "mixed", "data", "logic"] as const)
	line(`  ${k.padEnd(11)} ${String(counts[k]).padStart(4)}  ${pct(counts[k], total)}`);
const touchesFormatting = counts.formatting + counts.mixed;
line(
	`\n  touch presentation (formatting + mixed): ${touchesFormatting} (${pct(touchesFormatting, total)})`,
);

// Permeation: how many distinct lib files / directories hold formatting logic.
const filesWithFmt = new Set(
	libFns.filter((c) => c.kind === "formatting" || c.kind === "mixed").map((c) => c.relPath),
);
const allLibFiles = new Set(libFns.map((c) => c.relPath));
line(
	`  files containing formatting: ${filesWithFmt.size} / ${allLibFiles.size} ` +
		`(${pct(filesWithFmt.size, allLibFiles.size)})`,
);
const dirCounts = new Map<string, number>();
for (const f of filesWithFmt) dirCounts.set(parentDir(f), (dirCounts.get(parentDir(f)) ?? 0) + 1);
line(
	"  by directory: " +
		[...dirCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([d, n]) => `${d}:${n}`)
			.join("  "),
);

// ── 2. Dedicated formatting modules (the clean homes) ────────────────────────
const profiles = fileConcernProfiles(libFns);
line("\n## dedicated formatting modules (ratio \u2265 0.6, \u2265 3 fns)\n");
line(`${"file".padEnd(30)}fns  fmt  mix  data  logic  ratio`);
for (const p of profiles.filter((p) => p.functions >= 3 && p.formattingRatio >= 0.6))
	line(
		`  ${p.relPath.padEnd(30)}${String(p.functions).padStart(3)}  ${String(p.formatting).padStart(3)}  ` +
			`${String(p.mixed).padStart(3)}  ${String(p.data).padStart(4)}  ${String(p.logic).padStart(5)}  ` +
			`${p.formattingRatio.toFixed(2)}`,
	);

// ── 3. Formatting sprinkled in data-primary files ────────────────────────────
// A file whose dominant concern is data/logic but which still holds pure
// formatting functions — the "formatter living in a data module" case.
line("\n## formatting sprinkled in data-primary files\n");
const sprinkled = profiles
	.filter((p) => (p.dominant === "data" || p.dominant === "logic") && p.formatting > 0)
	.sort((a, b) => b.formatting - a.formatting);
for (const p of sprinkled) {
	const fns = libFns
		.filter((c) => c.relPath === p.relPath && c.kind === "formatting")
		.map((c) => (c.exported ? c.name : `${c.name}*`));
	line(
		`  ${p.relPath.padEnd(28)} ${p.formatting} formatter(s) among ${p.functions} fns ` +
			`(dominant: ${p.dominant})`,
	);
	line(`      ${fns.join(", ")}`);
}
line("\n  (* = non-exported / file-local; no trailing mark = exported)");

// ── 4. Mixed functions: retrieval + formatting coupled in one body ───────────
line("\n## mixed functions (async data access + formatted output)\n");
const mixedByFile = new Map<string, FunctionConcern[]>();
for (const c of libFns.filter((c) => c.kind === "mixed")) {
	const l = mixedByFile.get(c.relPath);
	if (l) l.push(c);
	else mixedByFile.set(c.relPath, [c]);
}
for (const [file, fns] of [...mixedByFile.entries()].sort((a, b) => b[1].length - a[1].length))
	line(`  ${file.padEnd(30)} ${fns.map((f) => f.name).join(", ")}`);

// ── 5. Command layer: formatting imported from lib ───────────────────────────
// Which lib formatting/mixed exports do commands import, and from where? Pulling
// formatting out of a *data-primary* file couples the presentation tier to it.
line("\n## command layer \u2192 lib formatting imports\n");
const graph = await buildImportGraph({ include: "src", root: "src" });
const concernById = new Map(concerns.map((c) => [c.id, c]));
const dominantByFile = new Map(profiles.map((p) => [p.relPath, p.dominant]));

const fmtImports = symbolEdges(graph).filter(
	(s) =>
		s.runtime &&
		s.fromRel.startsWith("commands/") &&
		s.toRel.startsWith("lib/") &&
		["formatting", "mixed"].includes(concernById.get(`${s.toRel}#${s.importedName}`)?.kind ?? ""),
);
const byExport = new Map<string, Set<string>>();
for (const s of fmtImports) {
	const key = `${s.toRel}#${s.importedName}`;
	const set = byExport.get(key) ?? new Set();
	set.add(s.fromRel.replace("commands/", ""));
	byExport.set(key, set);
}
line(
	`  ${fmtImports.length} formatting-symbol imports from commands into ${byExport.size} lib exports\n`,
);
const rows = [...byExport.entries()].sort((a, b) => b[1].size - a[1].size);
line(`${"lib export".padEnd(46)}#cmds  home-file concern`);
for (const [id, cmds] of rows.slice(0, 25)) {
	const file = id.slice(0, id.lastIndexOf("#"));
	const dom = dominantByFile.get(file) ?? "?";
	const flag = dom === "data" || dom === "logic" ? "  <-- data-primary file" : "";
	line(`  ${id.padEnd(46)}${String(cmds.size).padStart(4)}   ${dom}${flag}`);
}
