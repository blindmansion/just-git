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
	classifyConcerns,
	type ConcernKind,
	type ConcernOptions,
	type FileConcernProfile,
	fileConcernProfiles,
	type FunctionConcern,
} from "./concerns.ts";
export {
	barrelFiles,
	buildReverseIndex,
	type CoUsage,
	coUsageClusters,
	type Degree,
	degrees,
	dependencies,
	dependencyDepth,
	dependents,
	directoryMatrix,
	edgesWhere,
	exportConsumers,
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
	type SymbolEdge,
	symbolEdges,
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
	collectTypeShapes,
	type DuplicateShapeGroup,
	type DuplicateShapeOptions,
	findDuplicateTypeShapes,
	type ShapeKind,
	type TypeShape,
	typeShapeSignature,
} from "./type-shape.ts";
export {
	buildCallGraph,
	type CallEdge,
	type CallGraph,
	callCycles,
	callees,
	callers,
	type FunctionKind,
	type FunctionNode,
	type ModuleCohesion,
	moduleCallCohesion,
	uncalledFunctions,
} from "./call-graph.ts";
export {
	consolidateDeclaration,
	moveDeclaration,
	moveModules,
	type RefactorOptions,
	type RefactorResult,
	redirectSymbols,
	relativeSpecifier,
	renameSymbol,
} from "./refactor.ts";
