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
    let statementUncertain = false;
    if ('values' in clause) {
      if (!clause.values.includes(statement.value)) continue;
    } else if (clause.range.type === 'time') {
      const facet = statement.facet;
      if (facet?.kind === 'time') {
        if (!calendarRangeMatches(facet, clause.range)) continue;
      } else if (facet?.kind === 'unsupported' && facet.datatype === 'time') statementUncertain = true;
      else continue;
    } else {
      const { gte, lte, unit } = clause.range;
      const facet = statement.facet;
      if (unit === undefined && facet?.kind === 'time') {
        if ((gte !== undefined && facet.year < gte) || (lte !== undefined && facet.year > lte)) continue;
      } else if (unit !== undefined && facet?.kind === 'quantity' && facet.unit === unit) {
        if ((gte !== undefined && facet.amount < gte) || (lte !== undefined && facet.amount > lte)) continue;
      } else if (unit === undefined && facet?.kind === 'unsupported' && facet.datatype === 'time') {
        statementUncertain = true;
      } else if (unit !== undefined && facet?.kind === 'unsupported' && facet.datatype === 'quantity' && facet.unit === unit) {
        statementUncertain = true;
      } else {
        continue;
      }
    }
    let matches = true;
    for (const qualifier of clause.qualifiers ?? []) {
      const evidence = statement.qualifiers?.filter((value) => value.property === qualifier.property) ?? [];
      if ('range' in qualifier) {
        const { gte, lte, unit } = qualifier.range;
        if (
          evidence.some(
            ({ facet }) =>
              facet?.kind === 'quantity' &&
              facet.unit === unit &&
              (gte === undefined || facet.amount >= gte) &&
              (lte === undefined || facet.amount <= lte),
          )
        )
          continue;
        if (
          evidence.some(
            ({ facet }) =>
              facet?.kind === 'unsupported' && facet.datatype === 'quantity' && facet.unit === unit,
          )
        ) {
          statementUncertain = true;
          continue;
        }
        matches = false;
        break;
      }
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
    if (matches) {
      if (statementUncertain) uncertain = true;
      else return true;
    }
  }
  return uncertain ? 'not_proven' : false;
}
