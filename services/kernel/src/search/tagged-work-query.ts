import type { DiscoveryFilterDocument, FilterDocument, FilterRange, FilterRelease } from '@rezics/filter';
import { compileCurrentFilter, currentClauseKey } from './current-filter-plan.ts';
import { holdsCurrentStatements, holdsCurrentType } from './current-leaf.ts';
import { compileFilter } from './filter.ts';
import type { FactClause } from './disclosure/check.ts';
import type { IndexedStatement, IndexedSubject, RelationFacetMatch } from './source.ts';
import type { TaggedWorkOrder, TaggedWorkPlan } from './tagged-work-plan.ts';
import { taggedWorkCatalogueFilter } from './tagged-work-plan.ts';
import { proveCurrentKindCounts, type TypeFacetSubject } from './type-facet.ts';
import type { KindCountEvidence } from './discovery-api.ts';

export type TaggedWorkMembership = Readonly<{
  property: string;
  scheme: string;
  concept: string;
  values: ReadonlySet<string>;
}>;

/** Released catalogue-job meaning Search consumes; Concept UUIDs stay with Semantic classification(). */
export type TaggedWorkMeaning = Readonly<{
  words: 'schema:wordCount';
  form: 'wdt:P7937';
  tag: 'schema:keywords';
  genre: 'schema:genre';
  weight: 'rezics:sourceTagWeight';
  metric: 'rezics:sourceTagWeightMetric';
  spoiler: 'rezics:spoilerLevel';
  platform: 'schema:gamePlatform';
  language: 'schema:inLanguage';
  characters: 'schema:characterCount';
  pages: 'schema:numberOfPages';
  wordUnit: '1';
  weightUnit: '1';
  weightMetric: 'vndbTagsRating';
  wordsGreaterThanOneMillion: { gte: 1_000_001; unit: '1' };
}>;

export type TaggedWorkCursor = Readonly<{ id: string; name?: string }>;

export type TaggedWorkPage =
  | Readonly<{
      status: 'ready';
      hits: readonly IndexedSubject[];
      next: TaggedWorkCursor | null;
      examined: number;
      complete: boolean;
    }>
  | Readonly<{ status: 'preparing'; examined: number }>;

const meaningIds = {
  words: 'schema:wordCount',
  form: 'wdt:P7937',
  tag: 'schema:keywords',
  genre: 'schema:genre',
  weight: 'rezics:sourceTagWeight',
  metric: 'rezics:sourceTagWeightMetric',
  spoiler: 'rezics:spoilerLevel',
  platform: 'schema:gamePlatform',
  language: 'schema:inLanguage',
  characters: 'schema:characterCount',
  pages: 'schema:numberOfPages',
} as const;

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
  if (typeof selected !== 'string' || !selected) return;
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

export function evaluateTaggedWorkHit(
  subject: IndexedSubject,
  remaining: FilterDocument | undefined,
  kinds: readonly string[] | undefined,
  membership?: readonly TaggedWorkMembership[],
): RelationFacetMatch {
  if (kinds?.length && !kinds.includes(subject.type)) return false;
  return evaluateTaggedWorkPredicate(subject, remaining, membership);
}

export function currentTaggedWorkSubjects(
  subjects: readonly IndexedSubject[],
  remaining: FilterDocument | undefined,
  membership?: readonly TaggedWorkMembership[],
  kinds?: readonly string[],
): IndexedSubject[] {
  return subjects.filter((subject) => evaluateTaggedWorkHit(subject, remaining, kinds, membership) === true);
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

function propertyUnits(release: FilterRelease, property: string): readonly string[] {
  return release.properties[property]?.units ?? [];
}

/**
 * Bind catalogue-job property and unit identities from the active release.
 * Light-novel/harem Concept UUIDs and crossed platform/language tuples stay Semantic fixtures.
 */
export function releasedTaggedWorkMeaning(release: FilterRelease): TaggedWorkMeaning {
  const book = release.types['schema:Book'];
  if (!book?.facets?.includes(meaningIds.words)) throw new RangeError('Released Book word-count facet is missing');
  if (!book.facets.includes(meaningIds.form)) throw new RangeError('Released Book form facet is missing');
  const words = release.properties[meaningIds.words];
  const weight = release.properties[meaningIds.weight];
  const metric = release.properties[meaningIds.metric];
  if (!words || words.datatype !== 'quantity') throw new RangeError('Released word-count property is missing');
  if (!weight || weight.datatype !== 'quantity') throw new RangeError('Released source-tag weight is missing');
  if (!metric || metric.datatype !== 'string') throw new RangeError('Released source-tag weight metric is missing');
  const wordUnit = propertyUnits(release, meaningIds.words)[0] ?? '1';
  const weightUnit = propertyUnits(release, meaningIds.weight)[0] ?? '1';
  if (wordUnit !== '1') throw new RangeError('Released word-count unit must be 1');
  if (weightUnit !== '1') throw new RangeError('Released source-tag weight unit must be 1');
  return {
    ...meaningIds,
    wordUnit: '1',
    weightUnit: '1',
    weightMetric: 'vndbTagsRating',
    wordsGreaterThanOneMillion: { gte: 1_000_001, unit: '1' },
  };
}

export function taggedWorkNameKey(subject: IndexedSubject, languages?: readonly string[]): string {
  if (languages?.length) {
    for (const language of languages) {
      const label = subject.labels.find((entry) => entry.language === language);
      if (label?.value) return label.value;
    }
  }
  return subject.labels.find((entry) => entry.value)?.value ?? '';
}

export function compareTaggedWorkOrder(
  left: IndexedSubject,
  right: IndexedSubject,
  sort: Exclude<TaggedWorkOrder, 'rating'>,
  languages?: readonly string[],
): number {
  if (sort === 'id') return left.id.localeCompare(right.id);
  const a = taggedWorkNameKey(left, languages);
  const b = taggedWorkNameKey(right, languages);
  if (!a && b) return 1;
  if (a && !b) return -1;
  const names = a.localeCompare(b);
  return names !== 0 ? names : left.id.localeCompare(right.id);
}

function afterCursor(
  subject: IndexedSubject,
  after: TaggedWorkCursor,
  sort: Exclude<TaggedWorkOrder, 'rating'>,
  languages?: readonly string[],
): boolean {
  if (sort === 'id') return subject.id > after.id;
  const name = taggedWorkNameKey(subject, languages);
  const previous = after.name ?? '';
  if (!previous && name) return false;
  if (previous && !name) return true;
  const names = name.localeCompare(previous);
  return names !== 0 ? names > 0 : subject.id > after.id;
}

export function taggedWorkCursor(
  subject: IndexedSubject,
  sort: Exclude<TaggedWorkOrder, 'rating'>,
  languages?: readonly string[],
): TaggedWorkCursor {
  return sort === 'id' ? { id: subject.id } : { id: subject.id, name: taggedWorkNameKey(subject, languages) };
}

/**
 * Walk disclosed candidates in admitted name or id order. A filled page or certified
 * exhaustion is ready; spending the scan bound without either is finite preparation.
 */
export function pageTaggedWorkSubjects(input: {
  subjects: readonly IndexedSubject[];
  remaining: FilterDocument | undefined;
  membership?: readonly TaggedWorkMembership[] | undefined;
  kinds?: readonly string[] | undefined;
  sort: Exclude<TaggedWorkOrder, 'rating'>;
  limit: number;
  scanBound: number;
  after?: TaggedWorkCursor | undefined;
  languages?: readonly string[] | undefined;
  exhausted?: boolean | undefined;
}): TaggedWorkPage {
  const ordered = [...input.subjects].sort((left, right) =>
    compareTaggedWorkOrder(left, right, input.sort, input.languages),
  );
  const hits: IndexedSubject[] = [];
  let examined = 0;
  let complete = input.exhausted !== false;
  for (const subject of ordered) {
    if (examined >= input.scanBound) {
      complete = false;
      break;
    }
    examined++;
    if (input.after && !afterCursor(subject, input.after, input.sort, input.languages)) continue;
    if (evaluateTaggedWorkHit(subject, input.remaining, input.kinds, input.membership) !== true) continue;
    hits.push(subject);
    if (hits.length === input.limit) {
      const last = hits[hits.length - 1]!;
      const more = ordered.some(
        (candidate, index) =>
          index + 1 > examined &&
          evaluateTaggedWorkHit(candidate, input.remaining, input.kinds, input.membership) === true,
      );
      return {
        status: 'ready',
        hits,
        next: more ? taggedWorkCursor(last, input.sort, input.languages) : null,
        examined,
        complete: !more && input.exhausted !== false,
      };
    }
  }
  if (hits.length < input.limit && input.exhausted === false && !complete)
    return { status: 'preparing', examined };
  if (hits.length < input.limit && examined >= input.scanBound && input.exhausted === false)
    return { status: 'preparing', examined };
  return {
    status: 'ready',
    hits,
    next: null,
    examined,
    complete: input.exhausted !== false && examined < input.scanBound,
  };
}

export function pageTaggedWorkPlan(
  plan: TaggedWorkPlan,
  subjects: readonly IndexedSubject[],
  membership?: readonly TaggedWorkMembership[],
  after?: TaggedWorkCursor,
  languages?: readonly string[],
  exhausted?: boolean,
): TaggedWorkPage {
  if (plan.execution === 'preparing' || plan.sort === 'rating') return { status: 'preparing', examined: 0 };
  return pageTaggedWorkSubjects({
    subjects,
    remaining: taggedWorkCatalogueFilter(plan),
    membership,
    kinds: plan.selectedKinds,
    sort: plan.sort,
    limit: plan.limit,
    scanBound: plan.scanBound,
    after,
    languages,
    exhausted,
  });
}

export function taggedWorkCountSubjects(
  subjects: readonly IndexedSubject[],
  remaining: FilterDocument | undefined,
  membership?: readonly TaggedWorkMembership[],
): TypeFacetSubject[] {
  return currentTaggedWorkSubjects(subjects, remaining, membership).map((subject) => ({
    id: subject.id,
    type: subject.type,
  }));
}

export function proveTaggedWorkKindCounts(input: {
  subjects: readonly IndexedSubject[];
  remaining: FilterDocument | undefined;
  directory: readonly string[];
  membership?: readonly TaggedWorkMembership[] | undefined;
  complete: boolean;
}): ReadonlyMap<string, KindCountEvidence> {
  return proveCurrentKindCounts({
    subjects: taggedWorkCountSubjects(input.subjects, input.remaining, input.membership),
    directory: input.directory,
    complete: input.complete,
  });
}

export { quantityMatches };
