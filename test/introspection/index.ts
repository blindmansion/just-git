// Import-graph introspection toolkit.
//
// Build a typed import graph of any directory using the TypeScript compiler API,
// then run targeted queries about layering, refactoring opportunities, and
// import hygiene. See `introspection.test.ts` for usage examples.

export * from "./types.ts";
export {
	type AnalysisProgram,
	BUILTIN_BARE,
	classifySymbol,
	createAnalysisProgram,
	REPO_ROOT,
	toPosix,
} from "./program.ts";
export { buildImportGraph } from "./build-graph.ts";
export {
	barrelFiles,
	buildReverseIndex,
	type Degree,
	degrees,
	dependencies,
	dependencyDepth,
	dependents,
	directoryMatrix,
	edgesWhere,
	externalPackages,
	findCycles,
	findLayerViolations,
	getNode,
	type GroupMetrics,
	groupMatrix,
	groupMetrics,
	groupOf,
	internalNodes,
	isRuntimeEdge,
	type LayerViolation,
	parentDir,
	relPathOf,
	serializeGraph,
	stronglyConnectedComponents,
	typeImportCandidates,
	typeOnlyEdges,
	valueEdges,
} from "./query.ts";
export { formatCounts, formatMatrix } from "./format.ts";
export { type FileMetrics, fileMetrics, godFiles } from "./metrics.ts";
export {
	buildTestTopology,
	impactedTests,
	type TestTopology,
	type TestTopologyOptions,
	testsCovering,
} from "./test-topology.ts";
export {
	buildTypeGraph,
	type TypeDeclKind,
	type TypeEdge,
	type TypeGraph,
	type TypeNode,
	typeCycles,
	typeReferences,
	typeReferrers,
} from "./type-graph.ts";
export {
	buildCallGraph,
	type CallEdge,
	type CallGraph,
	callCycles,
	callees,
	callers,
	type FunctionKind,
	type FunctionNode,
	uncalledFunctions,
} from "./call-graph.ts";
export {
	moveDeclaration,
	moveModules,
	type RefactorOptions,
	type RefactorResult,
	relativeSpecifier,
} from "./refactor.ts";
