import type { FactClause } from './disclosure/check.ts';
import type { IndexedStatement, IndexedSubject, RelationFacetMatch } from './source.ts';
import type { TextNode } from './text.ts';
import { calendarRangeMatches } from '@rezics/filter';

/** Match the current type by exact membership in the clause's values. */
export function holdsCurrentType(type: string, clause: Extract<FactClause, { facet: 'type' }>): boolean {
  return clause.values.includes(type);
}

const wordSegments = new Intl.Segmenter('und', { granularity: 'word' });

function textTokens(value: string): string[] {
  return [...wordSegments.segment(value.normalize('NFKC').toLocaleLowerCase('und'))]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

/** Recheck the bounded text grammar against current labels, aliases and descriptions. */
export function holdsCurrentText(subject: Pick<IndexedSubject, 'labels' | 'aliases' | 'descriptions'>, node: TextNode): boolean {
  const corpus = [...subject.labels, ...subject.aliases, ...subject.descriptions]
    .map(({ value }) => value)
    .join(' ');
  const values = textTokens(corpus);
  const contains = (query: string, phrase: boolean) => {
    const wanted = textTokens(query);
    if (!wanted.length) return false;
    if (!phrase) return wanted.every((token) => values.includes(token));
    return values.some((_, offset) => wanted.every((token, index) => values[offset + index] === token));
  };
  const evaluate = (current: TextNode): boolean => {
    switch (current.kind) {
      case 'term':
        return contains(current.value, false);
      case 'phrase':
        return contains(current.value, true);
      case 'not':
        return !evaluate(current.child);
      case 'and':
        return current.children.every(evaluate);
      case 'or':
        return current.children.some(evaluate);
    }
  };
  return evaluate(node);
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
      if (!Number.isFinite(value) || (gte !== undefined && value < gte) || (lte !== undefined && value > lte)) continue;
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
