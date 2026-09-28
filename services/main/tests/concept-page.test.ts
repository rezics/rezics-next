import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { CONCEPT_FACET, CONCEPT_PAGE_COST, CONCEPT_WORKS_COST, conceptFilter, conceptPage, conceptWorksFilter,
  conceptWorksPage, conceptWorksQuery } from '../src/modules/concept-page/contract.ts';
import { readConcept, readConceptWorks } from '../src/modules/concept-page/read.ts';
import { type ConditionRow, DISCOVERY_CONDITION_COST, type DiscoveryCondition,
  discoveryConditionSql, decideConditionPage } from '../src/modules/discovery/store.ts';
import { checkedFilter, InvalidFilter } from '../src/modules/facets/schema.ts';
import { followCommand, followTargetMatches } from '../src/modules/follows/contract.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMissing, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' as const });
const concept = id(1), broader = id(2), narrower = id(3), include = id(4), exclude = id(5), bare = id(6);
const sense = (n: number) => id(100 + n);

test('G-409 a Concept is followed by its IRI under its own kind', () => {
  const command = { profile: 'follow-command-v1', actingSubject: id(9), following: true, expectedRevision: null };
  expect(Value.Check(followCommand, { ...command, target: concept, kind: 'concept' })).toBe(true);
  expect(followTargetMatches(concept, 'concept')).toBe(true);
  expect(followTargetMatches('open-library:OL21594A', 'concept')).toBe(false);
});

test('G-409 a Concept page and its Condition bar are Filters over the one Concept Facet', () => {
  expect(conceptFilter(concept)).toEqual({ all: [{ facet: CONCEPT_FACET, any: [concept] }] });
  expect(checkedFilter(conceptFilter(concept))).toEqual([CONCEPT_FACET]);
  expect(conceptWorksFilter(concept, [include], [exclude], 'all')).toEqual({ all: [
    { facet: CONCEPT_FACET, all: [concept, include] }, { facet: CONCEPT_FACET, none: [exclude] }] });
  expect(conceptWorksFilter(concept, [include], [], 'any')).toEqual({ all: [
    { facet: CONCEPT_FACET, any: [concept, include] }] });
  // The page's Concept and seven more reach the Facet's value bound; one more is a typed refusal.
  const seven = Array.from({ length: 7 }, (_, index) => id(20 + index));
  expect(checkedFilter(conceptWorksFilter(concept, seven, [], 'all'))).toEqual([CONCEPT_FACET]);
  expect(() => checkedFilter(conceptWorksFilter(concept, [...seven, id(30)], [], 'all'))).toThrow(InvalidFilter);
  expect(Value.Check(conceptWorksQuery, { include: seven })).toBe(true);
  expect(Value.Check(conceptWorksQuery, { include: [...seven, id(30)] })).toBe(false);
  expect(Value.Check(conceptWorksQuery, { scope: 'mine' })).toBe(false);
  // A Concept page is public: it takes no acting Agent.
  expect(Value.Check(conceptWorksQuery, { actingSubject: id(9) })).toBe(false);
});

const row = (work: number, key: number, term: string, matched = true): ConditionRow =>
  ({ work: id(work), order_key: String(key), term, matched });

test('G-409 a Condition page never decides a Work past a full drive window', () => {
  const [a, b] = [sense(1), sense(2)];
  // `a` filled its window of three at key 30: `b`'s row at 40 is undecided, so the page stops at 30.
  const scanned = [row(1, 10, a), row(2, 20, a, false), row(3, 30, a), row(1, 10, b), row(4, 40, b)];
  expect(decideConditionPage([a, b], scanned, 3, 20)).toEqual({ page: [row(1, 10, a), row(3, 30, a)],
    next: { key: '30', work: id(3) } });
  // With both seeks exhausted the page is complete, and a Work reached twice is listed once.
  expect(decideConditionPage([a, b], scanned, 4, 20)).toEqual({
    page: [row(1, 10, a), row(3, 30, a), row(4, 40, b)], next: null });
  // A full page resumes after its last Work, before any window horizon.
  expect(decideConditionPage([a, b], scanned, 4, 2)).toEqual({ page: [row(1, 10, a), row(3, 30, a)],
    next: { key: '30', work: id(3) } });
  // A window of non-matches is an empty page that still continues.
  expect(decideConditionPage([a], [row(1, 10, a, false), row(2, 20, a, false)], 2, 20))
    .toEqual({ page: [], next: { key: '20', work: id(2) } });
  // Keys compare as numbers, ties by Work IRI in byte order.
  expect(decideConditionPage([a], [row(2, 100, a), row(1, 100, a), row(3, 99, a)], 5, 20).page.map(item => item.work))
    .toEqual([id(3), id(1), id(2)]);
});

test('G-409 the Condition seek probes by primary key once per group and exclusion', () => {
  const sql = discoveryConditionSql(2, true, true);
  expect(sql.match(/EXISTS \(SELECT 1 FROM access\.discovery_entry x/g)).toHaveLength(3);
  expect(sql).toContain('x.term = ANY($7::text[])');
  expect(sql).toContain('NOT EXISTS');
  expect(sql).toContain('x.term = ANY($9::text[])');
  expect(sql).toContain('LIMIT $4');
  expect(discoveryConditionSql(0, false, false)).toContain('true AS matched');
  expect(DISCOVERY_CONDITION_COST.window * DISCOVERY_CONDITION_COST.driveTerms).toBeLessThanOrEqual(480);
});

interface FakeRead { queries: string[]; summaries: string[][] }
function fakeSession(read: FakeRead, graph: (query: string) => Record<string, unknown>[], language = 'fr') {
  const names: Record<string, string> = { [concept]: 'Fantasy', [broader]: 'Fiction', [narrower]: 'High fantasy',
    [include]: 'Magic', [exclude]: 'Romance', [bare]: 'Unused' };
  return { options: { language }, position: { dataEpoch: 'epoch', sequence: '9' },
    deps: { environment: {} },
    scope: async () => ({ kind: 'global', realm: null }),
    checkDeadline: () => undefined,
    query: async (query: string, limit: number) => {
      read.queries.push(query);
      const rows = graph(query);
      if (rows.length > limit) throw new WorkReadLimit('Read exceeds its bounded relation');
      return rows;
    },
    summaries: async (resources: string[]) => {
      read.summaries.push(resources);
      return resources.map(reference => names[reference] ? { reference, status: 'available', type: 'concept',
        disclosure: 'public', name: { ...name(names[reference]!), context: 'ignored' }, avatar: {} }
        : { reference, status: 'unavailable' });
    },
  } as unknown as WorkReadSession;
}
const binding = (value: string) => ({ type: 'uri', value });
const resolved = (senses: Record<string, string[]>) => (query: string) => query.includes('rv:ClassificationSense')
  ? Object.entries(senses).filter(([value]) => query.includes(`<${value}>`)).flatMap(([value, list]) =>
    list.length ? list.map(item => ({ concept: binding(value), sense: binding(item) })) : [{ concept: binding(value) }])
  : [];

test('G-409 a Concept page reads what the Concept is in two graph queries and one summary batch', async () => {
  const read: FakeRead = { queries: [], summaries: [] };
  const narrowerRows = Array.from({ length: CONCEPT_PAGE_COST.narrower + 1 }, (_, index) =>
    ({ relation: { type: 'literal', value: 'narrower' }, other: binding(index ? id(40 + index) : narrower) }));
  const session = fakeSession(read, query => query.includes('rv:ClassificationSense')
    ? [{ concept: binding(concept), sense: binding(sense(1)) }]
    : [{ definition: { type: 'literal', value: 'Stories of magic', 'xml:lang': 'en' } },
      { definition: { type: 'literal', value: 'Récits de magie', 'xml:lang': 'fr' } },
      { relation: { type: 'literal', value: 'broader' }, other: binding(broader) }, ...narrowerRows]);
  const page = await readConcept(session, concept);
  expect(Value.Check(conceptPage, page)).toBe(true);
  expect(page).toMatchObject({ id: concept, name: { value: 'Fantasy' }, facet: CONCEPT_FACET,
    description: { value: 'Récits de magie', language: 'fr', basis: 'requested' }, realm: null,
    interpretations: [sense(1)], broader: [{ id: broader, name: { value: 'Fiction' } }],
    moreNarrower: true, filter: conceptFilter(concept) });
  // Unnamed narrower Concepts (the synthetic ones here) are left out rather than shown without a name.
  expect(page.narrower).toEqual([{ id: narrower, name: name('High fantasy') }]);
  expect(read.queries).toHaveLength(CONCEPT_PAGE_COST.graphQueries);
  expect(read.queries[1]).toContain(`LIMIT ${CONCEPT_PAGE_COST.narrower + 1}`);
  expect(read.summaries).toHaveLength(CONCEPT_PAGE_COST.summaryBatches);
  expect(read.summaries[0]).toHaveLength(1 + 1 + CONCEPT_PAGE_COST.narrower);

  await expect(readConcept(fakeSession({ queries: [], summaries: [] }, () => []), concept))
    .rejects.toBeInstanceOf(WorkReadMissing);
  const crowded = fakeSession({ queries: [], summaries: [] }, () => Array.from({ length: 5 }, (_, index) =>
    ({ concept: binding(concept), sense: binding(sense(index)) })));
  await expect(readConcept(crowded, concept)).rejects.toBeInstanceOf(WorkReadLimit);
});

function fakeProjection(counts: Record<string, number>, stale = [false, false]) {
  const calls: { condition: DiscoveryCondition; limit: number }[] = [];
  let checks = 0;
  return { calls, projection: {
    active: async () => ({ generation_id: '00000000-0000-4000-8000-000000000077', source_epoch: 'epoch',
      source_sequence: '9', stale: stale[checks++] }),
    selectedTerms: async (_generation: unknown, terms: string[]) => terms.filter(term => counts[term])
      .map(term => ({ term, concept, work_count: String(counts[term]) })),
    conditionPage: async (_generation: unknown, _type: string, condition: DiscoveryCondition, limit: number) => {
      calls.push({ condition, limit });
      return { rows: [], next: null };
    },
  } as never };
}

test('G-409 Works reaching a Concept seek by the rarest included value and check the rest per Work', async () => {
  const senses = { [concept]: [sense(1)], [include]: [sense(2), sense(3)], [exclude]: [sense(4)], [bare]: [] };
  const read: FakeRead = { queries: [], summaries: [] };
  const { calls, projection } = fakeProjection({ [sense(1)]: 900, [sense(2)]: 4, [sense(3)]: 1, [sense(4)]: 50 });
  const page = await readConceptWorks(fakeSession(read, resolved(senses)), projection, concept,
    { include: [include], exclude: [exclude] });
  expect(calls).toEqual([{ condition: { drive: [sense(2), sense(3)], groups: [[sense(1)]], excluded: [sense(4)] },
    limit: CONCEPT_WORKS_COST.pageSize }]);
  expect(Value.Check(conceptWorksPage, page)).toBe(true);
  expect(page).toMatchObject({ match: 'all', stale: false, matches: { value: 0, kind: 'exact' },
    values: [{ id: concept, operator: 'include' }, { id: include, operator: 'include' },
      { id: exclude, operator: 'exclude', name: { value: 'Romance' } }] });
  expect(read.queries).toHaveLength(CONCEPT_WORKS_COST.graphQueries);
  expect(read.summaries.filter(batch => batch.length)).toHaveLength(CONCEPT_WORKS_COST.summaryBatches);

  // Any included value: every interpretation drives the seek and nothing else is required.
  const any = fakeProjection({});
  await readConceptWorks(fakeSession({ queries: [], summaries: [] }, resolved(senses)), any.projection, concept,
    { include: [include, bare], match: 'any', limit: 5 });
  expect(any.calls).toEqual([{ condition: { drive: [sense(1), sense(2), sense(3)], groups: [], excluded: [] },
    limit: 5 }]);

  // A value no Work was classified under, or one with no Works, empties `all` without a seek.
  for (const [values, counts] of [[[bare], { [sense(1)]: 3 }], [[include], { [sense(1)]: 3 }]] as const) {
    const none = fakeProjection(counts);
    const empty = await readConceptWorks(fakeSession({ queries: [], summaries: [] }, resolved(senses)), none.projection,
      concept, { include: [...values] });
    expect(none.calls).toEqual([]);
    expect(empty).toMatchObject({ items: [], nextCursor: null, matches: { value: 0, kind: 'exact' } });
  }
  // A projection that moved while reading withholds its matches.
  const moved = fakeProjection({ [sense(1)]: 3 }, [false, true]);
  expect(await readConceptWorks(fakeSession({ queries: [], summaries: [] }, resolved(senses)), moved.projection,
    concept, {})).toMatchObject({ stale: true, items: [], matches: { kind: 'lower-bound' } });
});

test('G-409 a Condition bar refuses contradictions and hidden values instead of listing nothing', async () => {
  const senses = { [concept]: [sense(1)], [include]: [sense(2)] };
  const read = () => fakeSession({ queries: [], summaries: [] }, resolved(senses));
  const { projection } = fakeProjection({});
  for (const query of [{ include: [include], exclude: [include] }, { exclude: [concept] }, { include: [concept] }]) {
    await expect(readConceptWorks(read(), projection, concept, query)).rejects.toBeInstanceOf(WorkReadInvalid);
  }
  // `exclude` resolves to no visible Concept: the page names it missing rather than ignoring it.
  await expect(readConceptWorks(read(), projection, concept, { exclude: [exclude] }))
    .rejects.toBeInstanceOf(WorkReadMissing);
});
