// Shared TypeScript program/checker bootstrap. Every analysis in this toolkit
// (import graph, type graph, call graph, metrics) starts from a `ts.Program`
// scoped to part of the repo; this module builds it once and exposes the
// checker plus the set of "internal" source files (those under `include`).
//
// Keeping this generic — rather than buried inside the import-graph builder —
// is what lets new checker-backed analyses be written in a few lines.

import * as path from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";
import type { ProgramOptions, SymbolKind } from "./types.ts";

/** Absolute path of the repo root (two levels up from `test/introspection`). */
export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const DEFAULT_IGNORE = ["/node_modules/", "/dist/", "/.sandbox/", "/.git/"];

/** Bare specifiers that are Node/Bun builtins (the `node:` prefix is separate). */
export const BUILTIN_BARE = new Set([
	"assert",
	"async_hooks",
	"buffer",
	"child_process",
	"cluster",
	"console",
	"constants",
	"crypto",
	"dgram",
	"diagnostics_channel",
	"dns",
	"domain",
	"events",
	"fs",
	"http",
	"http2",
	"https",
	"inspector",
	"module",
	"net",
	"os",
	"path",
	"perf_hooks",
	"process",
	"punycode",
	"querystring",
	"readline",
	"repl",
	"stream",
	"string_decoder",
	"sys",
	"timers",
	"tls",
	"trace_events",
	"tty",
	"url",
	"util",
	"v8",
	"vm",
	"wasi",
	"worker_threads",
	"zlib",
	"bun",
]);

/** Normalise OS path separators to POSIX `/`. */
export function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

function isIgnored(file: string, ignore: string[]): boolean {
	const norm = toPosix(file);
	return ignore.some((frag) => norm.includes(frag));
}

/** Resolve compiler options from a tsconfig, forcing a non-emitting type-check program. */
function loadCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
	const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (read.error) {
		throw new Error(
			`Failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`,
		);
	}
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath));
	return { ...parsed.options, noEmit: true, declaration: false };
}

/** Glob `*.ts`/`*.tsx` (and optionally `*.d.ts`) under each include root. */
async function collectFiles(roots: string[], opts: ProgramOptions): Promise<string[]> {
	const ignore = opts.ignore ?? DEFAULT_IGNORE;
	const out = new Set<string>();
	for (const root of roots) {
		const glob = new Glob("**/*.{ts,tsx}");
		for await (const abs of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
			if (isIgnored(abs, ignore)) continue;
			if (!opts.includeDeclarations && abs.endsWith(".d.ts")) continue;
			out.add(path.resolve(abs));
		}
	}
	return [...out].sort();
}

function commonAncestor(paths: string[]): string {
	if (paths.length === 0) return REPO_ROOT;
	if (paths.length === 1) return paths[0] as string;
	const split = paths.map((p) => toPosix(p).split("/"));
	const first = split[0] as string[];
	const result: string[] = [];
	for (let i = 0; i < first.length; i++) {
		const seg = first[i];
		if (split.every((parts) => parts[i] === seg)) result.push(seg as string);
		else break;
	}
	return result.join("/") || "/";
}

/** Classify a symbol (resolved through aliases) into value/type/namespace buckets. */
export function classifySymbol(checker: ts.TypeChecker, symbol: ts.Symbol): SymbolKind {
	let s = symbol;
	if (s.flags & ts.SymbolFlags.Alias) {
		try {
			s = checker.getAliasedSymbol(s);
		} catch {
			// Aliased target not resolvable (e.g. missing module) — keep the alias symbol.
		}
	}
	const isValue = (s.flags & ts.SymbolFlags.Value) !== 0;
	const isType = (s.flags & ts.SymbolFlags.Type) !== 0;
	const isNamespace = (s.flags & ts.SymbolFlags.Namespace) !== 0;
	if (isValue && isType) return "value-and-type";
	if (isValue) return "value";
	if (isType) return "type";
	if (isNamespace) return "namespace";
	return "unknown";
}

/** A bootstrapped program plus conveniences for the internal file set. */
export interface AnalysisProgram {
	program: ts.Program;
	checker: ts.TypeChecker;
	/** Base directory for `relOf`. */
	root: string;
	/** Absolute include roots. */
	includeRoots: string[];
	/** Absolute paths of the internal (include-root) files. */
	files: string[];
	/** Parsed source files under `include` (declaration files excluded by default). */
	sourceFiles: ts.SourceFile[];
	/** Whether an absolute file path is one of the internal files. */
	isInternal(file: string): boolean;
	/** Root-relative POSIX path for an absolute file. */
	relOf(file: string): string;
}

/**
 * Build a `ts.Program` scoped to `options.include` and return it alongside the
 * checker and the internal file set.
 *
 * @example
 * const { checker, sourceFiles, relOf } = await createAnalysisProgram({ include: "src/lib" });
 * for (const sf of sourceFiles) { ... checker.getSymbolAtLocation(...) ... }
 */
export async function createAnalysisProgram(options: ProgramOptions): Promise<AnalysisProgram> {
	const includeRoots = (Array.isArray(options.include) ? options.include : [options.include]).map(
		(p) => path.resolve(REPO_ROOT, p),
	);
	const root = options.root ? path.resolve(REPO_ROOT, options.root) : commonAncestor(includeRoots);
	const tsconfigPath = options.tsconfigPath
		? path.resolve(REPO_ROOT, options.tsconfigPath)
		: path.join(REPO_ROOT, "tsconfig.json");

	const compilerOptions = loadCompilerOptions(tsconfigPath);
	const rootNames = await collectFiles(includeRoots, options);
	const program = ts.createProgram({ rootNames, options: compilerOptions });
	const checker = program.getTypeChecker();

	const includeSet = new Set(rootNames);
	const isInternal = (file: string) => includeSet.has(path.resolve(file));
	const relOf = (file: string) => toPosix(path.relative(root, path.resolve(file)));
	const sourceFiles = program.getSourceFiles().filter((sf) => {
		if (sf.isDeclarationFile && !options.includeDeclarations) return false;
		return includeSet.has(path.resolve(sf.fileName));
	});

	return { program, checker, root, includeRoots, files: rootNames, sourceFiles, isInternal, relOf };
}
