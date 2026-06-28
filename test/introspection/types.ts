// Core data model for the import graph.
//
// A graph is a set of module *nodes* (one per source file under the configured
// `include` roots) connected by directed *edges* (one per `import` / `export …
// from` statement). Each edge carries per-specifier *bindings* that the
// TypeScript type checker has classified as value / type / namespace, plus the
// resolution category of the target module. See `build-graph.ts` for how this
// is populated and `query.ts` for analyses built on top of it.

/**
 * How the type checker classifies an imported/exported symbol, resolved through
 * any aliases (`import { X }` where `X` is itself a re-export).
 *
 * - `value` — purely a runtime value (function, const, let var, getter…).
 * - `type` — purely a type (interface, type alias, type parameter…).
 * - `value-and-type` — occupies both meanings (class, enum, namespace-merged).
 * - `namespace` — a module/namespace object (`import * as ns`).
 * - `unknown` — checker produced no symbol (unresolved import, JS file…).
 */
export type SymbolKind = "value" | "type" | "value-and-type" | "namespace" | "unknown";

/** Shape of the imported binding within an `import`/`export` statement. */
export type ImportClauseKind = "named" | "default" | "namespace" | "side-effect";

/** Where a module specifier resolves to, relative to the graph's `include` roots. */
export type EdgeTarget =
	/** A source file under the graph's `include` roots. */
	| "internal"
	/** A project file resolved outside the `include` roots (e.g. `src` when graphing `src/lib`). */
	| "external-project"
	/** Resolved into `node_modules`. */
	| "package"
	/** A Node builtin (`node:fs`, `fs`, `bun`…). */
	| "builtin"
	/** Could not be resolved by the checker. */
	| "unresolved";

/** A single named/default/namespace binding pulled in by an edge. */
export interface ImportBinding {
	/** Name as exported by the *target* module. `"default"` for default imports, `"*"` for namespace. */
	importedName: string;
	/** Local name it is bound to in the importing file. */
	localName: string;
	/**
	 * True when this specific binding is type-only — either `import type { X }`
	 * (whole clause) or the inline `import { type X }` form.
	 */
	isTypeOnly: boolean;
	/** Checker classification of the binding, resolved through aliases. */
	kind: SymbolKind;
	/**
	 * The checker's type string for value bindings, e.g. `(a: number) => void`.
	 * Only populated when `includeTypeStrings` is enabled (it is comparatively
	 * expensive). Undefined for pure types and when classification fails.
	 */
	typeString?: string;
}

/** A directed import/export-from relationship between a file and a module specifier. */
export interface ImportEdge {
	/** Absolute path of the importing file. */
	fromFile: string;
	/** Module specifier exactly as written, e.g. `"../lib/foo.ts"` or `"node:path"`. */
	specifier: string;
	/** Resolved absolute path of the target module, or undefined when external/unresolved. */
	toFile?: string;
	/** Resolution category of `specifier` relative to the graph's include roots. */
	target: EdgeTarget;
	/** True when the entire statement is `import type` / `export type`. */
	isTypeOnly: boolean;
	/** Whether the relationship comes from an `import` or a re-`export … from`. */
	statement: "import" | "export";
	/** Clause shapes present (a statement may mix default + named). */
	clauseKinds: ImportClauseKind[];
	/** Per-specifier bindings. Empty for side-effect imports and bare `export *`. */
	bindings: ImportBinding[];
	/** 1-based line of the statement within `fromFile`. */
	line: number;
}

/** A symbol exported by an internal module (computed via the checker). */
export interface ExportInfo {
	/** Exported name (`"default"` for the default export). */
	name: string;
	/** Checker classification of the export. */
	kind: SymbolKind;
	/** True when the export is an alias originating from another module (barrel re-export). */
	isReExport: boolean;
}

/** A file in the graph. */
export interface ModuleNode {
	/** Absolute path. */
	file: string;
	/** Path relative to `graph.root`, using POSIX separators. */
	relPath: string;
	/** Whether the file is an `include` root file, a `package`, or a `builtin`. */
	category: Extract<EdgeTarget, "internal" | "external-project" | "package" | "builtin">;
	/** Outgoing import/export-from edges declared in this file. */
	imports: ImportEdge[];
	/** Names this module exports (only computed for internal files). */
	exports: ExportInfo[];
}

/** A fully built import graph. */
export interface ImportGraph {
	/** Absolute path that `relPath`s are computed against. */
	root: string;
	/** Absolute include roots used to decide `internal` vs `external-project`. */
	includeRoots: string[];
	/** All nodes, keyed by absolute file path. Iteration order is sorted by path. */
	nodes: Map<string, ModuleNode>;
	/** Flattened list of every edge across all nodes (convenience for filtering). */
	edges: ImportEdge[];
	/** Non-fatal issues encountered while building (unresolved modules, checker gaps). */
	diagnostics: string[];
}

/**
 * Shared options for building a `ts.Program` over part of the repo. Every
 * analysis (import graph, type graph, call graph, metrics…) takes these — see
 * `createAnalysisProgram` in `program.ts`.
 */
export interface ProgramOptions {
	/**
	 * Directory or directories whose files are the analysis subject. For graphs,
	 * these become the internal nodes; anything referenced from *outside* these
	 * roots is treated as external.
	 */
	include: string | string[];
	/**
	 * Base directory for `relPath` computation. Defaults to the common ancestor of
	 * the include roots (or the repo root when a single root is given).
	 */
	root?: string;
	/**
	 * tsconfig to source compiler options (module resolution, paths, lib…) from.
	 * Defaults to the repo `tsconfig.json` next to the workspace root.
	 */
	tsconfigPath?: string;
	/** Include `*.d.ts` files. Default false. */
	includeDeclarations?: boolean;
	/**
	 * Absolute/relative path fragments to skip while collecting files. Defaults to
	 * `node_modules`, `dist`, `.sandbox`, `.git`.
	 */
	ignore?: string[];
}

/** Options for {@link buildImportGraph}. */
export interface BuildGraphOptions extends ProgramOptions {
	/**
	 * Compute `ImportBinding.typeString` for value bindings via the checker.
	 * Slower (forces type materialisation); default false.
	 */
	includeTypeStrings?: boolean;
	/**
	 * Also create nodes for resolved `package` / `external-project` targets so the
	 * graph is closed under reachability. Default false (only include roots become
	 * nodes). Builtins are never turned into nodes.
	 */
	includeExternalNodes?: boolean;
}
