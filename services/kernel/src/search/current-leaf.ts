import type { FactClause } from './disclosure/check.ts';
import type { IndexedStatement } from './source.ts';
import { calendarRangeMatches } from '@rezics/filter';

/** Match the current type by exact membership in the clause's values. */
export function holdsCurrentType(type: string, clause: Extract<FactClause, { facet: 'type' }>): boolean {
  return clause.values.includes(type);
}

/**
 * Match one current statement, including ALL qualifiers on that SAME statement.
 * This pure matcher consumes selected evidence, without subject identity or Access checks.
 * A false result on a PARTIAL native evidence window is not definitive absence. The caller
 * needs the owner's current complete-absence proof; otherwise it passes not_proven to the
 * one Boolean planner. Native evidence supplies data/provenance, never another interpreter.
 */
export function holdsCurrentStatements(
  statements: readonly IndexedStatement[],
  clause: Extract<FactClause, { facet: 'statement' }>,
): boolean {
  return statements.some((statement) => {
    if (statement.property !== clause.property) return false;
    if ('values' in clause) {
      if (!clause.values.includes(statement.value)) return false;
    } else if (clause.range.type === 'time') {
      if (statement.facet?.kind !== 'time' || !calendarRangeMatches(statement.facet, clause.range)) return false;
    } else {
      const { gte, lte, unit } = clause.range;
      const facet = statement.facet;
      let value: number;
      if (unit === undefined) {
        if (facet?.kind !== 'time') return false;
        value = facet.year;
      } else {
        if (facet?.kind !== 'quantity' || facet.unit !== unit) return false;
        value = facet.amount;
      }
      if (!Number.isFinite(value) || (gte !== undefined && value < gte) || (lte !== undefined && value > lte))
        return false;
    }
    return (clause.qualifiers ?? []).every((qualifier) =>
      statement.qualifiers?.some(
        (value) => value.property === qualifier.property && qualifier.in.includes(value.value),
      ),
    );
  });
}
