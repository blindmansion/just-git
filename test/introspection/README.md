# Import-graph introspection toolkit

Build a typed **import graph** of any directory using the TypeScript compiler
API, then query it to understand the repo: layering, module boundaries,
refactoring candidates, dead/indirect import paths, and architectural
invariants.

Unlike grep/regex scanning, this resolves modules and asks the **type checker**
what each import actually is — so it can tell a runtime value dependency apart
from an erased `import type`. That distinction is the whole point: type-only
edges may point anywhere and never form real cycles, so every meaningful
layering/cycle question is asked over _runtime_ edges.

## Files

- `program.ts` — the shared bootstrap: `createAnalysisProgram(options)` builds a
  `ts.Program` + checker scoped to a directory. **Every analysis starts here.**
- `types.ts` — shared options + the import-graph data model.
- `build-graph.ts` — `buildImportGraph(options)`, the import-graph builder.
- `query.ts` — composable graph analyses (traversal, cycles, degrees, depth, layering, group metrics, generic SCC).
- `format.ts` — `formatMatrix` / `formatCounts` for readable script output.
- `metrics.ts` — AST-only size/shape metrics + `godFiles` finder (no checker, fast).
- `type-graph.ts` — type→type reference graph (finds type-level tangles/cycles).
- `call-graph.ts` — function-level call graph (who-calls-whom, recursion, dead helpers, per-module cohesion).
- `concerns.ts` — formatting-vs-data concern classifier (which functions format, retrieve data, or do both).
- `test-topology.ts` — maps tests↔source (coverage, untested files, change impact).
- `index.ts` — barrel; import everything from here.
- `*.test.ts` — worked examples (`introspection`, `analyses`) and the live `layering` policy.

The toolkit is layered: `program.ts` (bootstrap) → analyses (`build-graph`,
`type-graph`, `call-graph`, `metrics`) → generic helpers (`query`, `format`).
Pass an existing `AnalysisProgram` to `buildTypeGraph` / `buildCallGraph` /
`fileMetrics` to run several analyses off one program without re-parsing.

## Quick start

```typescript
import { buildImportGraph } from "./test/introspection/index.ts";

// Scope the graph to whatever you're investigating:
const whole = await buildImportGraph({ include: "src", root: "src" });
const lib = await buildImportGraph({ include: "src/lib", root: "src/lib" });
const oneDir = await buildImportGraph({ include: "src/server" });
```

Nodes are the files under `include`; edges are imports/re-exports. Anything
imported from outside `include` is categorised (`external-project` / `package`
/ `builtin`) rather than added as a node. Pass `includeTypeStrings: true` to
attach checker type strings to value bindings (slower).

## The exploration loop (use `bun -e`)

The intended workflow is **incremental, throwaway exploration with `bun -e`** —
ask one question, read the answer, refine. Don't write a file; pipe a few lines
into bun:

```bash
bun -e '
import { buildImportGraph, findCycles, isRuntimeEdge, relPathOf } from "./test/introspection/index.ts";
const g = await buildImportGraph({ include: "src/lib", root: "src/lib" });
const rel = f => relPathOf(g, f);
for (const c of findCycles(g, { edgeFilter: isRuntimeEdge }))
  console.log(c.map(rel).join("  <->  "));
'
```

Typical questions and the helper that answers them:

| Question                                 | Helper                                                             |
| ---------------------------------------- | ------------------------------------------------------------------ |
| What depends on / is depended on by X?   | `dependencies`, `dependents`, `buildReverseIndex`                  |
| Which _symbol_ of X does each file use?  | `symbolEdges` (per-binding) / `exportConsumers` (per-export)       |
| Which of a module's exports are co-used? | `coUsageClusters` (Jaccard over consumer sets — split-seam finder) |
| Are there import cycles? (runtime ones!) | `findCycles(g, { edgeFilter: isRuntimeEdge })`                     |
| How do directories import each other?    | `directoryMatrix` / `groupMatrix` + `formatMatrix`                 |
| What are the hubs / leaves?              | `degrees(g, { edgeFilter: isRuntimeEdge })`                        |
| What's the dependency hierarchy/depth?   | `dependencyDepth(g, { edgeFilter: isRuntimeEdge })`                |
| Should these files be a directory?       | `groupMetrics(g, [...])` (cohesion vs coupling)                    |
| Does the code respect a layering?        | `findLayerViolations(g, layers, { edgeFilter: isRuntimeEdge })`    |
| What external deps are used?             | `externalPackages` + `formatCounts`                                |
| Imports that should be `import type`?    | `typeImportCandidates`                                             |
| Pure re-export/barrel files?             | `barrelFiles`                                                      |

Almost every import-graph analysis takes an optional `edgeFilter` so
`isRuntimeEdge` (or any predicate) composes uniformly.

### Beyond the import graph

The same bootstrap powers analyses that aren't about imports at all:

| Question                                                     | Helper                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Which files are god-files? (exports/LOC/fn length)           | `fileMetrics` + `godFiles`                                        |
| Type-level tangles / cycles (e.g. `hooks.ts`↔`lib/types.ts`) | `buildTypeGraph` + `typeCycles` / `typeReferrers`                 |
| Who calls this function? Recursion? Dead helpers?            | `buildCallGraph` + `callers` / `callCycles` / `uncalledFunctions` |
| How internally wired is each module (call cohesion)?         | `buildCallGraph` + `moduleCallCohesion`                           |
| Is formatting tangled with data retrieval?                   | `classifyConcerns` + `fileConcernProfiles`                        |
| Which tests exercise a src file? What's untested?            | `buildTestTopology` + `testsCovering` / `.uncovered`              |
| I changed these files — which tests must I run?              | `impactedTests(topo, changed)`                                    |
| Which types/interfaces are the same shape under diff names?  | `findDuplicateTypeShapes` (+ `collectTypeShapes`)                 |

```bash
bun -e '
import { createAnalysisProgram, buildTypeGraph, typeCycles, buildCallGraph, uncalledFunctions } from "./test/introspection/index.ts";
const prog = await createAnalysisProgram({ include: "src/lib", root: "src/lib" });
console.log("type cycles:", typeCycles(await buildTypeGraph(prog)).length);
console.log("dead helpers:", uncalledFunctions(await buildCallGraph(prog)).length);
'
```

## Materialize repeated patterns

When the same shim shows up across several `bun -e` sessions — the classic one
is `f => g.nodes.get(f)?.relPath ?? f`, or building a runtime adjacency, or a
grouped count matrix — **promote it into the toolkit** rather than re-pasting
it. Analysis helpers belong in `query.ts`, presentation helpers in `format.ts`.
Add a focused example to `introspection.test.ts`, then export it from
`index.ts`. (`relPathOf`, `degrees`, `dependencyDepth`, `groupMetrics`,
`groupMatrix`, and `formatMatrix` all started life as inline script snippets.)
Keep `query.ts` analysis-only and leave genuinely one-off, judgement-heavy
exploration (e.g. ad-hoc clustering) in scripts.

## Turning findings into guards

Anything you discover can become a standing test. `layering.test.ts` encodes the
current architecture (dependency-free core, downward-only runtime deps, a
baselined cycle allowlist) and fails if a regression sneaks in. See
[`local-docs/plans/lib-internal-structure.md`](../../local-docs/plans/lib-internal-structure.md)
and its `lib-structure-evidence.ts` for an example of an investigation written
up as a plan plus a reproducible evidence script.

## Validation

```bash
bun test test/introspection/   # unit + policy tests
bun check                      # typecheck + format + lint
```
