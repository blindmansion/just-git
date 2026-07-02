// Structural shape analysis: find type/interface declarations that expand to
// the *same* shape under (possibly) different names — i.e. candidates to
// consolidate into a single definition. Unlike the type-reference graph, this
// ignores who-mentions-whom; it canonicalises each declaration's structure via
// the checker into a name-independent signature, then buckets declarations by
// that signature.
//
// The signature expands the *declaration itself* (its members / union arms /
// call signatures) but refers to member types by the checker's printed form
// (so a member typed `ObjectId` stays `ObjectId`). Two declarations therefore
// collide only when they have the same members with the same member types —
// which is exactly the "reimplemented the same shape twice" case.

import * as path from "node:path";
import * as ts from "typescript";
import { type AnalysisProgram, createAnalysisProgram } from "./program.ts";
import type { ProgramOptions } from "./types.ts";

export type ShapeKind = "interface" | "type-alias";

export interface TypeShape {
	/** Stable id: `${relPath}#${name}`. */
	id: string;
	name: string;
	file: string;
	relPath: string;
	kind: ShapeKind;
	exported: boolean;
	/** Canonical, name-independent structural signature. */
	signature: string;
}

export interface DuplicateShapeGroup {
	signature: string;
	/** Declarations sharing this exact shape, sorted by id. */
	members: TypeShape[];
	/** True when the group spans more than one distinct declaration name. */
	distinctNames: boolean;
}

export interface DuplicateShapeOptions {
	/** Only report buckets with at least this many declarations. Default `2`. */
	minGroupSize?: number;
	/** Drop trivial shapes (bare primitives, literals, empty object). Default `true`. */
	skipTrivial?: boolean;
	/** Only consider exported declarations. Default `false`. */
	exportedOnly?: boolean;
	/** Which declaration kinds to include. Default both. */
	kinds?: ShapeKind[];
}

const FMT =
	ts.TypeFormatFlags.NoTruncation |
	ts.TypeFormatFlags.UseStructuralFallback |
	ts.TypeFormatFlags.WriteArrayAsGenericType;

const PRIMITIVE_SIGNATURES = new Set([
	"string",
	"number",
	"boolean",
	"bigint",
	"symbol",
	"any",
	"unknown",
	"never",
	"void",
	"null",
	"undefined",
	"object",
	"true",
	"false",
	"{}",
]);

function isExported(node: ts.Node): boolean {
	const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
	return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function isReadonlySymbol(sym: ts.Symbol): boolean {
	const decl = sym.valueDeclaration ?? sym.declarations?.[0];
	if (!decl) return false;
	return (ts.getCombinedModifierFlags(decl as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0;
}

function symbolType(checker: ts.TypeChecker, sym: ts.Symbol): ts.Type {
	const decl = sym.valueDeclaration ?? sym.declarations?.[0];
	return decl ? checker.getTypeOfSymbolAtLocation(sym, decl) : checker.getDeclaredTypeOfSymbol(sym);
}

function signatureText(checker: ts.TypeChecker, sig: ts.Signature): string {
	const params = sig
		.getParameters()
		.map((p) => `${p.getName()}: ${checker.typeToString(symbolType(checker, p), undefined, FMT)}`);
	const ret = checker.typeToString(sig.getReturnType(), undefined, FMT);
	return `(${params.join(", ")}) => ${ret}`;
}

/**
 * Canonicalise a type into a name-independent structural signature. Top-level
 * unions/intersections are expanded (arms sorted); object shapes serialise
 * their members (sorted), index signatures, and call/construct signatures.
 * Member types are printed by the checker (named types stay named), and a depth
 * cap keeps recursive/self-referential types from expanding forever.
 */
export function typeShapeSignature(checker: ts.TypeChecker, type: ts.Type, depth = 0): string {
	if (depth > 6) return checker.typeToString(type, undefined, FMT);

	if (type.isUnion()) {
		return `(${type.types
			.map((t) => typeShapeSignature(checker, t, depth + 1))
			.sort()
			.join(" | ")})`;
	}
	if (type.isIntersection()) {
		return `(${type.types
			.map((t) => typeShapeSignature(checker, t, depth + 1))
			.sort()
			.join(" & ")})`;
	}

	// Only expand *genuine* object types. Primitives, string/number literals and
	// enums have "apparent" members (the String/Number prototype) that
	// getPropertiesOfType would otherwise splice in — so print them by name.
	if ((type.flags & ts.TypeFlags.Object) === 0) {
		return checker.typeToString(type, undefined, FMT);
	}

	const props = checker.getPropertiesOfType(type);
	const callSigs = type.getCallSignatures();
	const ctorSigs = type.getConstructSignatures();
	const indexInfos = checker.getIndexInfosOfType(type);
	const objectLike = props.length + callSigs.length + ctorSigs.length + indexInfos.length > 0;
	if (!objectLike) return checker.typeToString(type, undefined, FMT);

	const parts: string[] = [];
	for (const p of props) {
		const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
		const ro = isReadonlySymbol(p);
		const t = checker.typeToString(symbolType(checker, p), undefined, FMT);
		parts.push(`${ro ? "readonly " : ""}${p.getName()}${optional ? "?" : ""}: ${t}`);
	}
	for (const info of indexInfos) {
		const key = checker.typeToString(info.keyType, undefined, FMT);
		const val = checker.typeToString(info.type, undefined, FMT);
		parts.push(`[index: ${key}]${info.isReadonly ? " readonly" : ""}: ${val}`);
	}
	for (const sig of callSigs) parts.push(`call ${signatureText(checker, sig)}`);
	for (const sig of ctorSigs) parts.push(`new ${signatureText(checker, sig)}`);
	parts.sort();
	return `{ ${parts.join("; ")} }`;
}

function isTrivialSignature(sig: string): boolean {
	if (PRIMITIVE_SIGNATURES.has(sig)) return true;
	// A bare literal: `"foo"`, `'bar'`, `` `baz` ``, or a numeric literal.
	if (/^["'`]/.test(sig) || /^-?\d/.test(sig)) return true;
	return false;
}

/**
 * Collect a structural {@link TypeShape} for every interface / type-alias in the
 * configured directories. Declaration-merged interfaces are recorded once.
 *
 * @example
 * const shapes = await collectTypeShapes({ include: "src/lib" });
 */
export async function collectTypeShapes(
	source: ProgramOptions | AnalysisProgram,
	opts: DuplicateShapeOptions = {},
): Promise<TypeShape[]> {
	const prog = "program" in source ? source : await createAnalysisProgram(source);
	const { checker, relOf } = prog;
	const kinds = new Set<ShapeKind>(opts.kinds ?? ["interface", "type-alias"]);
	const seen = new Set<string>();
	const shapes: TypeShape[] = [];

	for (const sf of prog.sourceFiles) {
		const file = path.resolve(sf.fileName);
		const rel = relOf(file);
		for (const stmt of sf.statements) {
			if (!ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt)) continue;
			const kind: ShapeKind = ts.isInterfaceDeclaration(stmt) ? "interface" : "type-alias";
			if (!kinds.has(kind)) continue;

			const name = stmt.name.text;
			const id = `${rel}#${name}`;
			if (seen.has(id)) continue; // interface declaration-merging: record once
			seen.add(id);

			const exported = isExported(stmt);
			if (opts.exportedOnly && !exported) continue;

			const sym = checker.getSymbolAtLocation(stmt.name);
			if (!sym) continue;
			const type = checker.getDeclaredTypeOfSymbol(sym);
			shapes.push({
				id,
				name,
				file,
				relPath: rel,
				kind,
				exported,
				signature: typeShapeSignature(checker, type),
			});
		}
	}
	return shapes;
}

/**
 * Group interface / type-alias declarations by identical structural shape,
 * surfacing consolidation candidates: two `{ a: string; b: number }` shapes
 * under different names land in one group.
 *
 * @example
 * const dupes = await findDuplicateTypeShapes({ include: "src", root: "src" });
 * for (const g of dupes)
 *   console.log(g.members.map((m) => m.id).join("  ==  "), "\n  ", g.signature);
 */
export async function findDuplicateTypeShapes(
	source: ProgramOptions | AnalysisProgram,
	opts: DuplicateShapeOptions = {},
): Promise<DuplicateShapeGroup[]> {
	const minGroupSize = opts.minGroupSize ?? 2;
	const skipTrivial = opts.skipTrivial ?? true;
	const shapes = await collectTypeShapes(source, opts);

	const byShape = new Map<string, TypeShape[]>();
	for (const s of shapes) {
		if (skipTrivial && isTrivialSignature(s.signature)) continue;
		const bucket = byShape.get(s.signature);
		if (bucket) bucket.push(s);
		else byShape.set(s.signature, [s]);
	}

	const groups: DuplicateShapeGroup[] = [];
	for (const [signature, members] of byShape) {
		if (members.length < minGroupSize) continue;
		members.sort((a, b) => a.id.localeCompare(b.id));
		groups.push({
			signature,
			members,
			distinctNames: new Set(members.map((m) => m.name)).size > 1,
		});
	}
	// Biggest clusters first; stable tie-break on signature.
	groups.sort(
		(a, b) => b.members.length - a.members.length || a.signature.localeCompare(b.signature),
	);
	return groups;
}
