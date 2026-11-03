import type { FactClause } from './disclosure/check.ts';
import type { IndexedStatement, RelationFacetMatch } from './source.ts';
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
): RelationFacetMatch {
  let uncertain = false;
  for (const statement of statements) {
    if (statement.property !== clause.property) continue;
    if ('values' in clause) {
      if (!clause.values.includes(statement.value)) continue;
    } else if (clause.range.type === 'time') {
      if (statement.facet?.kind !== 'time' || !calendarRangeMatches(statement.facet, clause.range)) continue;
    } else {
      const { gte, lte, unit } = clause.range;
      const facet = statement.facet;
      let value: number;
      if (unit === undefined) {
        if (facet?.kind !== 'time') continue;
        value = facet.year;
      } else {
        if (facet?.kind !== 'quantity' || facet.unit !== unit) continue;
        value = facet.amount;
      }
      if (!Number.isFinite(value) || (gte !== undefined && value < gte) || (lte !== undefined && value > lte))
        continue;
    }
    let matches = true;
    for (const qualifier of clause.qualifiers ?? []) {
      const evidence = statement.qualifiers?.filter((value) => value.property === qualifier.property) ?? [];
      if (qualifier.property === 'rezics:spoilerLevel') {
        const levels = new Set(evidence.map((value) => value.value));
        if (levels.size > 1) {
          uncertain = true;
          matches = false;
          break;
        }
        if (levels.size === 1 && !['0', '1', '2'].includes(evidence[0]!.value)) {
          matches = false;
          break;
        }
      }
      if (!evidence.some((value) => qualifier.in.includes(value.value))) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return uncertain ? 'not_proven' : false;
}
