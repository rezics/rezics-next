import type { FactClause } from './disclosure/check.ts';
import type { IndexedStatement } from './source.ts';

/** Match the current type by exact membership in the clause's values. */
export function holdsCurrentType(_type: string, _clause: Extract<FactClause, { facet: 'type' }>): boolean {
  // Specification-stage stub; the existing disclosure matcher will be extracted here next.
  throw new Error('Current type matching is not implemented');
}

/**
 * Match one current statement, including ALL qualifiers on that SAME statement.
 * This pure matcher consumes selected evidence, without subject identity or Access checks.
 * A false result on a PARTIAL native evidence window is not definitive absence. The caller
 * needs the owner's current complete-absence proof; otherwise it passes not_proven to the
 * one Boolean planner. Native evidence supplies data/provenance, never another interpreter.
 */
export function holdsCurrentStatements(
  _statements: readonly IndexedStatement[],
  _clause: Extract<FactClause, { facet: 'statement' }>,
): boolean {
  throw new Error('Current statement matching is not implemented');
}
