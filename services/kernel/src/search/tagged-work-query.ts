import type { DiscoveryFilterDocument, FilterDocument, FilterRange } from '@rezics/filter';
import { compileCurrentFilter, currentClauseKey } from './current-filter-plan.ts';
import { holdsCurrentStatements, holdsCurrentType } from './current-leaf.ts';
import { compileFilter } from './filter.ts';
import type { FactClause } from './disclosure/check.ts';
import type { IndexedStatement, IndexedSubject, RelationFacetMatch } from './source.ts';
import type { TaggedWorkPlan } from './tagged-work-plan.ts';
import { taggedWorkCatalogueFilter } from './tagged-work-plan.ts';

export type TaggedWorkMembership = Readonly<{
  property: string;
  scheme: string;
  concept: string;
  values: ReadonlySet<string>;
}>;

function quantityMatches(statement: IndexedStatement, range: FilterRange): boolean {
  return (
    holdsCurrentStatements([statement], {
      facet: 'statement',
      property: statement.property,
      range,
    }) === true
  );
}

function descendantValues(
  clause: Extract<FactClause, { facet: 'statement'; values: readonly string[] }>,
  membership: readonly TaggedWorkMembership[] | undefined,
): readonly string[] | undefined {
  if (!clause.concept?.includeChildren) return clause.values;
  const selected = clause.values[0];
  const cut = membership?.find(
    (entry) =>
      entry.property === clause.property && entry.scheme === clause.concept!.scheme && entry.concept === selected,
  );
  if (!cut) return;
  return [...new Set([selected, ...cut.values])];
}

function statementMatch(
  statements: readonly IndexedStatement[],
  clause: Extract<FactClause, { facet: 'statement' }>,
  membership: readonly TaggedWorkMembership[] | undefined,
): RelationFacetMatch {
  if (!('values' in clause) || !clause.concept) return holdsCurrentStatements(statements, clause);
  const values = descendantValues(clause, membership);
  if (values === undefined) return 'not_proven';
  return holdsCurrentStatements(statements, { ...clause, values });
}

/**
 * Evaluate the remaining catalogue predicate on one current disclosed subject.
 * Descendant cuts are supplied by the retained concept membership owner; exact tags and
 * same-statement quantity/weight/metric/spoiler use the shared numeric matcher.
 */
export function evaluateTaggedWorkPredicate(
  subject: IndexedSubject,
  remaining: FilterDocument | undefined,
  membership?: readonly TaggedWorkMembership[],
): RelationFacetMatch {
  if (subject.visibility !== 'visible' || subject.redirect !== null) return false;
  if (remaining === undefined) return true;
  const plan = compileCurrentFilter(remaining);
  const values: RelationFacetMatch[] = plan.leaves.map((clause) =>
    clause.facet === 'type'
      ? holdsCurrentType(subject.type, clause)
      : statementMatch(subject.statements, clause, membership),
  );
  return plan.evaluate(values);
}

export function currentTaggedWorkSubjects(
  subjects: readonly IndexedSubject[],
  remaining: FilterDocument | undefined,
  membership?: readonly TaggedWorkMembership[],
): IndexedSubject[] {
  return subjects.filter((subject) => evaluateTaggedWorkPredicate(subject, remaining, membership) === true);
}

/** Engine candidate query for the remaining predicate. Concept closures stay match_all for native evaluation. */
export function compileTaggedWorkFilter(remaining: FilterDocument | undefined, prefix = 'tagged') {
  if (remaining === undefined) return { query: { match_all: { _name: `${prefix}all` } }, leaves: [] };
  return compileFilter(remaining, { prefix, relationOverflow: true });
}

export function compileTaggedWorkPlanFilter(plan: TaggedWorkPlan, prefix = 'tagged') {
  return compileTaggedWorkFilter(taggedWorkCatalogueFilter(plan), prefix);
}

export function taggedWorkLeafKey(clause: FactClause): string {
  return currentClauseKey(clause);
}

export function inclusiveQuantityBound(amount: number, range: { gte?: number; lte?: number }): boolean {
  if (!Number.isFinite(amount)) return false;
  if (range.gte !== undefined && amount < range.gte) return false;
  if (range.lte !== undefined && amount > range.lte) return false;
  return true;
}

/** Inclusive word-count grammar used by catalogue jobs: gte 1000001 with unit `1`. */
export function bookWordsGreaterThanOneMillion(amount: number, unit: string): boolean {
  return unit === '1' && inclusiveQuantityBound(amount, { gte: 1_000_001 });
}

export function remainingHasConceptDescendants(remaining: DiscoveryFilterDocument | undefined): boolean {
  if (!remaining) return false;
  const pending: DiscoveryFilterDocument[] = [remaining];
  while (pending.length) {
    const node = pending.pop()!;
    if ('and' in node) pending.push(...node.and);
    else if ('or' in node) pending.push(...node.or);
    else if ('not' in node) pending.push(node.not);
    else if ('statement' in node && 'in' in node.statement && node.statement.concept?.includeChildren === true)
      return true;
  }
  return false;
}

export { quantityMatches };
