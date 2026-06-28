// Cheap, AST-only size/shape metrics per file. No type checker needed, so this
// is fast even over the whole repo. Useful for surfacing god-files (high export
// count / long functions) — the signal that flagged `command-utils.ts`.

import * as path from "node:path";
import * as ts from "typescript";
import { createAnalysisProgram, type AnalysisProgram } from "./program.ts";
import type { ProgramOptions } from "./types.ts";

/** Size/shape metrics for a single source file. */
export interface FileMetrics {
	/** Root-relative POSIX path. */
	relPath: string;
	/** Absolute path. */
	file: string;
	/** Total physical lines. */
	lines: number;
	/** Lines that are not blank and not a `//` line comment. */
	codeLines: number;
	/** Number of exported declarations (functions, classes, types, consts, re-exports…). */
	exports: number;
	/** Top-level statements in the file. */
	topLevelStatements: number;
	/** Number of function/method/arrow declarations. */
	functions: number;
	/** Longest function body in lines (0 if none). */
	maxFunctionLines: number;
	/** Maximum statement nesting depth (a rough complexity proxy). */
	maxNestingDepth: number;
}

function countExports(sf: ts.SourceFile): number {
	let count = 0;
	for (const stmt of sf.statements) {
		const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
		const isExported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
		if (ts.isExportDeclaration(stmt)) {
			// `export { a, b }` / `export * from …`
			const clause = stmt.exportClause;
			if (clause && ts.isNamedExports(clause)) count += clause.elements.length;
			else count += 1;
			continue;
		}
		if (ts.isExportAssignment(stmt)) {
			count += 1;
			continue;
		}
		if (!isExported) continue;
		if (
			ts.isVariableStatement(stmt) // `export const a = …, b = …`
		) {
			count += stmt.declarationList.declarations.length;
		} else {
			count += 1;
		}
	}
	return count;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

function analyzeSource(sf: ts.SourceFile, source: string): Omit<FileMetrics, "relPath" | "file"> {
	const physical = source.split("\n");
	const lines = physical.length;
	const codeLines = physical.filter((l) => {
		const t = l.trim();
		return t.length > 0 && !t.startsWith("//");
	}).length;

	let functions = 0;
	let maxFunctionLines = 0;
	let maxNestingDepth = 0;

	const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;

	const walk = (node: ts.Node, depth: number): void => {
		if (isFunctionLike(node)) {
			functions++;
			const body = (node as ts.FunctionLikeDeclaration).body;
			if (body) {
				const span = lineOf(body.getEnd()) - lineOf(body.getStart(sf)) + 1;
				if (span > maxFunctionLines) maxFunctionLines = span;
			}
		}
		const opensBlock = ts.isBlock(node) || ts.isCaseBlock(node) || ts.isModuleBlock(node);
		const nextDepth = opensBlock ? depth + 1 : depth;
		if (nextDepth > maxNestingDepth) maxNestingDepth = nextDepth;
		ts.forEachChild(node, (child) => walk(child, nextDepth));
	};
	walk(sf, 0);

	return {
		lines,
		codeLines,
		exports: countExports(sf),
		topLevelStatements: sf.statements.length,
		functions,
		maxFunctionLines,
		maxNestingDepth,
	};
}

/**
 * Compute {@link FileMetrics} for every internal file, sorted by `relPath`.
 * Accepts an existing {@link AnalysisProgram} (to avoid re-bootstrapping) or
 * options to build one.
 */
export async function fileMetrics(
	source: ProgramOptions | AnalysisProgram,
): Promise<FileMetrics[]> {
	const prog = "program" in source ? source : await createAnalysisProgram(source);
	const out: FileMetrics[] = [];
	for (const sf of prog.sourceFiles) {
		const file = path.resolve(sf.fileName);
		out.push({ relPath: prog.relOf(file), file, ...analyzeSource(sf, sf.getFullText()) });
	}
	out.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return out;
}

/**
 * Files that look like god-files / refactor candidates by exceeding any of the
 * given thresholds. Defaults are deliberately loose; tune per investigation.
 */
export function godFiles(
	metrics: FileMetrics[],
	thresholds: { exports?: number; codeLines?: number; maxFunctionLines?: number } = {},
): FileMetrics[] {
	const exp = thresholds.exports ?? 20;
	const loc = thresholds.codeLines ?? 400;
	const fn = thresholds.maxFunctionLines ?? 120;
	return metrics
		.filter((m) => m.exports >= exp || m.codeLines >= loc || m.maxFunctionLines >= fn)
		.sort((a, b) => b.exports - a.exports || b.codeLines - a.codeLines);
}
