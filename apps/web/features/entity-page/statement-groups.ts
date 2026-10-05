import type { PredicateLabels } from './predicate-labels.ts';
import type { StatementGroup, StatementItem } from './types.ts';

// Which statements a list draws and under what heading. Pure, so stories and the views import it without Main's reads.

const NAME_PREDICATE = 'https://schema.org/name';

/** The text a statement's value carries when it is a string, for comparing with a name. */
function lexicalOf(item: StatementItem): string | null {
  const value = item.value as { lexical?: unknown };
  return typeof value.lexical === 'string' ? value.lexical : null;
}

/** A group's items without the page's own name, which its heading already says; other names stay. */
export function withoutOwnName(group: StatementGroup, ownName?: string): StatementItem[] {
  return group.predicate === NAME_PREDICATE && ownName !== undefined
    ? group.items.filter(item => lexicalOf(item) !== ownName) : group.items;
}

/**
 * What a statements list draws: the groups whose predicate has a label, and the values of every other predicate in one
 * list for "Other facts". The page's own name is dropped.
 */
export function presentStatements(groups: readonly StatementGroup[], labels: PredicateLabels, ownName?: string) {
  const labelled: StatementGroup[] = [];
  const other: StatementItem[] = [];
  for (const group of groups) {
    const items = withoutOwnName(group, ownName);
    if (!items.length) continue;
    if (labels.has(group.predicate)) labelled.push({ ...group, items });
    else other.push(...items);
  }
  return { labelled, other };
}
