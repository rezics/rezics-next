import { expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import type { FactClause, Hit } from '../../src/search/disclosure/check.ts';
import { readLiveFacets } from '../../src/search/live-facets.ts';
import type {
  IndexedStatement,
  IndexedSubject,
  RelationFacetProbe,
  RelationFacetMatch,
  SubjectSource,
} from '../../src/search/source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const author = 'schema:author';
const code = 'schema:inLanguage';
const release = {
  types: {
    'schema:Book': { facets: [author, code], labels: { en: 'Book', fr: 'Livre' } },
    'schema:Person': { facets: [], labels: { en: 'Person' } },
  },
  properties: {
    [author]: { datatype: 'wikibase-item' },
    [code]: { datatype: 'string', value: { pattern: '^[a-z]{2,3}$' } },
  },
} as unknown as FilterRelease;

const item = (value: string): IndexedStatement => ({ property: author, value, facet: { kind: 'item' } });
const coded = (value: string): IndexedStatement => ({ property: code, value, facet: { kind: 'code' } });
const subject = (
  n: number,
  statements: IndexedStatement[] = [],
  patch: Partial<IndexedSubject> = {},
): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements,
  ...patch,
});
const hit = (n: number, patch: Partial<Hit> = {}): Hit => ({
  id: id(n),
  partition: 10,
  securityRevision: 1,
  matched: [],
  ...patch,
});

class ControlledSource implements SubjectSource {
  readonly reads: { partition: number; ids: readonly string[] }[] = [];
  readonly probes: RelationFacetProbe[][] = [];
  readonly subjects = new Map<string, IndexedSubject>();
  readonly relationResults = new Map<string, RelationFacetMatch>();
  readFailure?: Error;
  readFailureAt?: number;
  probeFailure?: Error;

  put(value: IndexedSubject) {
    this.subjects.set(value.id, value);
  }

  relationKey(probe: RelationFacetProbe) {
    return JSON.stringify(probe);
  }

  async read(partition: number, ids: readonly string[]) {
    this.reads.push({ partition, ids: [...ids] });
    if (this.readFailure && (this.readFailureAt === undefined || this.reads.length === this.readFailureAt))
      throw this.readFailure;
    const wanted = new Set(ids);
    return {
      partition,
      position: 1n,
      subjects: [...this.subjects.values()].filter((value) => wanted.has(value.id)),
    };
  }

  async count(_partition: number): Promise<{ position: bigint; count: number }> {
    throw new Error('Live facets must not scan source partitions');
  }

  async matchRelationFacets(_partition: number, probes: readonly RelationFacetProbe[]) {
    this.probes.push([...probes]);
    if (this.probeFailure) throw this.probeFailure;
    return probes.map((probe) => {
      const override = this.relationResults.get(this.relationKey(probe));
      if (override !== undefined) return override;
      const value = this.subjects.get(probe.subject);
      return Boolean(
        value?.statements.some((statement) => statement.property === probe.property && statement.value === probe.value),
      );
    });
  }
}

const clauses = (...entries: [string, FactClause][]) => new Map(entries);
const result = (
  source: ControlledSource,
  hits: readonly Hit[],
  options: Partial<Parameters<typeof readLiveFacets>[0]> = {},
) =>
  readLiveFacets({
    source,
    hits,
    clauses: clauses(),
    facets: [{ property: author, size: 10 }],
    release,
    complete: true,
    ...options,
  });

test('live facet counts include only current disclosed source matches and values', async () => {
  const source = new ControlledSource();
  const target = subject(90, [], { type: 'schema:Person' });
  source.put(target);
  source.put(subject(1, [item(target.id)], { visibility: 'hidden' }));
  source.put(subject(2, [item(target.id)], { visibility: 'taken_down' }));
  source.put(subject(3, [item(target.id)]));

  const answer = await result(source, [hit(1), hit(2), hit(3), hit(4)]);

  expect(answer.facets[0]).toEqual({
    property: author,
    relation: 'lower_bound',
    values: [{ value: target.id, count: 1, labels: { en: 'Book 90' } }],
  });
  expect(answer.total).toEqual({ value: 1, relation: 'lower_bound' });
});

test('current item targets are disclosed before a bucket or its label is returned', async () => {
  const source = new ControlledSource();
  const visible = subject(91, [], { type: 'schema:Person' });
  source.put(visible);
  source.put(subject(1, [item(visible.id), item(visible.id)]));
  source.put(subject(2, [item(id(92))]));
  source.put(subject(92, [], { type: 'schema:Person', visibility: 'taken_down' }));

  const answer = await result(source, [hit(1), hit(2)]);

  expect(answer.facets[0]!.values).toEqual([{ value: visible.id, count: 1, labels: { en: 'Book 91' } }]);
  expect(source.reads.some(({ ids }) => ids.includes(id(92)))).toBe(true);
});

test('type and code buckets count distinct current sources and use stable count/value ordering', async () => {
  const source = new ControlledSource();
  source.put(subject(1, [coded('fr'), coded('fr'), coded('en')]));
  source.put(subject(2, [coded('fr')], { type: 'schema:Person' }));
  source.put(subject(3, [coded('en')]));

  const answer = await readLiveFacets({
    source,
    hits: [hit(1), hit(2), hit(3), hit(1)],
    clauses: clauses(),
    facets: [
      { property: 'type', size: 5 },
      { property: code, size: 5 },
    ],
    release,
    complete: true,
  });

  expect(answer.total).toEqual({ value: 3, relation: 'exact' });
  expect(answer.facets).toEqual([
    {
      property: 'type',
      relation: 'exact',
      values: [
        { value: 'schema:Book', count: 2, labels: { en: 'Book' } },
        { value: 'schema:Person', count: 1, labels: { en: 'Person' } },
      ],
    },
    {
      property: code,
      relation: 'exact',
      values: [
        { value: 'en', count: 2, labels: {} },
        { value: 'fr', count: 2, labels: {} },
      ],
    },
  ]);
});

test('positive relation candidates are rechecked and stale or not-proven witnesses only lower-bound counts', async () => {
  for (const match of [false, 'not_proven'] as const) {
    const source = new ControlledSource();
    const stale = subject(1, []);
    const current = subject(2, [item(id(90))]);
    source.put(subject(90, [], { type: 'schema:Person' }));
    source.put(stale);
    source.put(current);
    const probe = { subject: stale.id, property: author, value: id(90) };
    source.relationResults.set(source.relationKey(probe), match);
    const filter = { statement: { property: author, in: [id(90)] } } as const;
    const answer = await result(source, [hit(1, { matched: ['f1'] }), hit(2, { matched: ['f1'] })], {
      clauses: clauses(['f1', { facet: 'statement', property: author, values: [id(90)] }]),
      filter,
      relationProperties: [author],
    });

    expect(source.probes.flat()).toContainEqual(probe);
    expect(answer.total).toEqual({ value: 1, relation: 'lower_bound' });
    expect(answer.facets[0]!.values).toEqual([{ value: id(90), count: 1, labels: { en: 'Book 90' } }]);
  }
});

test('positive relation candidates are rechecked from the release when relation properties are omitted', async () => {
  const source = new ControlledSource();
  const relationRelease = {
    ...release,
    properties: {
      ...release.properties,
      [author]: {
        datatype: 'wikibase-item',
        relation: { group: 'association' },
      },
    },
  } as unknown as FilterRelease;
  source.put(subject(90, [], { type: 'schema:Person' }));
  source.put(subject(1, [item(id(90))]));
  const probe = { subject: id(1), property: author, value: id(90) };
  source.relationResults.set(source.relationKey(probe), false);

  const answer = await result(source, [hit(1, { matched: ['f1'] })], {
    clauses: clauses(['f1', { facet: 'statement', property: author, values: [id(90)] }]),
    filter: { statement: { property: author, in: [id(90)] } },
    release: relationRelease,
  });

  expect(source.probes.flat()).toContainEqual(probe);
  expect(answer.total).toEqual({ value: 0, relation: 'lower_bound' });
  expect(answer.facets[0]!.values).toEqual([]);
});

test('complete Boolean OR and NOT proof counts only current matching candidates', async () => {
  const source = new ControlledSource();
  source.put(subject(90, [], { type: 'schema:Person' }));
  source.put(subject(1, [item(id(90))], { type: 'schema:Book' }));
  source.put(subject(2, [], { type: 'schema:Person' }));
  source.put(subject(3, [], { type: 'schema:Book' }));
  const relationLeaf: FactClause = { facet: 'statement', property: author, values: [id(90)] };
  const typeLeaf: FactClause = { facet: 'type', values: ['schema:Person'] };
  const filter = {
    or: [
      { statement: { property: author, in: [id(90)] } },
      { and: [{ type: { in: ['schema:Person'] } }, { not: { type: { in: ['schema:Book'] } } }] },
    ],
  } as const;
  const answer = await result(
    source,
    [hit(1, { matched: ['f1'] }), hit(2, { matched: ['f2'] }), hit(3, { matched: ['f1', 'f2'] })],
    {
      clauses: clauses(['f1', relationLeaf], ['f2', typeLeaf]),
      filter,
      relationProperties: [author],
    },
  );

  expect(answer.total).toEqual({ value: 2, relation: 'lower_bound' });
  expect(answer.facets[0]!.values).toEqual([{ value: id(90), count: 1, labels: {} }]);
});

test('repeated facts and duplicate hits contribute once per source and value', async () => {
  const source = new ControlledSource();
  source.put(subject(1, [coded('en'), coded('en'), coded('fr')]));

  const answer = await readLiveFacets({
    source,
    hits: [hit(1), hit(1)],
    clauses: clauses(),
    facets: [{ property: code, size: 5 }],
    release,
    complete: true,
  });

  expect(answer.total).toEqual({ value: 1, relation: 'exact' });
  expect(answer.facets[0]!.values).toEqual([
    { value: 'en', count: 1, labels: {} },
    { value: 'fr', count: 1, labels: {} },
  ]);
});

test('candidate, facet, size and language bounds are rejected before source reads', async () => {
  const source = new ControlledSource();
  const oversized = Array.from({ length: 201 }, (_, index) => hit(index + 1));

  await expect(result(source, oversized)).rejects.toThrow();
  await expect(
    readLiveFacets({
      source,
      hits: [],
      clauses: clauses(),
      facets: Array.from({ length: 9 }, (_, index) => ({ property: `property:${index}`, size: 1 })),
      release,
      complete: true,
    }),
  ).rejects.toThrow();
  await expect(
    readLiveFacets({
      source,
      hits: [],
      clauses: clauses(),
      facets: [{ property: code, size: 21 }],
      release,
      complete: true,
    }),
  ).rejects.toThrow();
  await expect(result(source, [], { languages: Array.from({ length: 9 }, () => 'en') })).rejects.toThrow();
  expect(source.reads).toEqual([]);
});

test('the helper probes labels only for the top two values per requested result slot', async () => {
  const source = new ControlledSource();
  for (let index = 1; index <= 4; index++) {
    source.put(subject(index, [item(id(90 + index))]));
    source.put(subject(90 + index, [], { type: 'schema:Person' }));
  }

  const answer = await result(source, [hit(1), hit(2), hit(3), hit(4)], {
    facets: [{ property: author, size: 1 }],
  });

  expect(answer.facets[0]!.values).toHaveLength(1);
  const readIds = source.reads.flatMap(({ ids }) => ids);
  const candidateIds = new Set([id(1), id(2), id(3), id(4)]);
  expect(readIds.filter((value) => !candidateIds.has(value)).length).toBeLessThanOrEqual(2);
});

test('incomplete samples and empty samples are lower bounds while a verified complete sample is exact', async () => {
  const source = new ControlledSource();
  source.put(subject(1, [coded('en')]));

  const incomplete = await readLiveFacets({
    source,
    hits: [hit(1)],
    clauses: clauses(),
    facets: [{ property: code, size: 5 }],
    release,
    complete: false,
  });
  const exact = await readLiveFacets({
    source,
    hits: [hit(1)],
    clauses: clauses(),
    facets: [{ property: code, size: 5 }],
    release,
    complete: true,
  });
  const empty = await readLiveFacets({
    source,
    hits: [],
    clauses: clauses(),
    facets: [{ property: code, size: 5 }],
    release,
    complete: true,
  });

  expect(incomplete.total).toEqual({ value: 1, relation: 'lower_bound' });
  expect(incomplete.facets[0]!.relation).toBe('lower_bound');
  expect(exact.total).toEqual({ value: 1, relation: 'exact' });
  expect(exact.facets[0]!.relation).toBe('exact');
  expect(empty.total).toEqual({ value: 0, relation: 'lower_bound' });
  expect(empty.facets[0]!.relation).toBe('lower_bound');
});

test('facet value labels use the existing language chain and original-language fallback', async () => {
  const source = new ControlledSource();
  const target = subject(90, [{ property: 'schema:inLanguage', value: 'zh-Hant', facet: { kind: 'code' } }], {
    type: 'schema:Person',
    labels: [
      { language: 'en', value: 'Author' },
      { language: 'zh-Hant', value: '作者' },
    ],
  });
  source.put(target);
  source.put(subject(1, [item(target.id)]));

  const answer = await result(source, [hit(1)], { languages: ['fr'] });

  expect(answer.facets[0]!.values).toEqual([{ value: target.id, count: 1, labels: { 'zh-Hant': '作者' } }]);
});

test('source and relation proof failures propagate instead of returning empty facets', async () => {
  const readFailure = new ControlledSource();
  readFailure.readFailure = new Error('source snapshot failed');
  await expect(result(readFailure, [hit(1)])).rejects.toThrow('source snapshot failed');

  const labelFailure = new ControlledSource();
  labelFailure.put(subject(1, [item(id(90))]));
  labelFailure.readFailure = new Error('facet value snapshot failed');
  labelFailure.readFailureAt = 2;
  await expect(result(labelFailure, [hit(1)])).rejects.toThrow('facet value snapshot failed');

  const probeFailure = new ControlledSource();
  probeFailure.put(subject(1, [item(id(90))]));
  probeFailure.probeFailure = new Error('relation witness failed');
  await expect(
    result(probeFailure, [hit(1, { matched: ['f1'] })], {
      clauses: clauses(['f1', { facet: 'statement', property: author, values: [id(90)] }]),
      filter: { statement: { property: author, in: [id(90)] } },
      relationProperties: [author],
    }),
  ).rejects.toThrow('relation witness failed');
});
