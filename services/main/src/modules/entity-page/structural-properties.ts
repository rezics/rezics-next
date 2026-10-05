import { SEMANTIC_TERMS } from '../semantic/schema.ts';

/** Component properties that bind a Resource to its owner rather than say something about it. The Relations section
 * already draws the owner, so the statements disclosure never lists them as facts. */
const structuralPredicates: ReadonlySet<string> = new Set([SEMANTIC_TERMS.semanticWork]);

export const isStructuralProperty = (predicate: string) => structuralPredicates.has(predicate);
