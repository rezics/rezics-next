import { expect, test } from 'bun:test';
import type { FilterDocument, FilterQualifier } from '@rezics/filter';
import { checkHits, type FactClause, type Hit } from '../../src/search/disclosure/check.ts';
import { compileFilter } from '../../src/search/filter.ts';
import {
  MAX_RELATION_FACET_PROBES,
  MAX_RELATION_FACET_VALUES,
  subjectPartition,
  type IndexedSubject,
  type RelationFacetProbe,
  type SubjectSource,
} from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

const id = (n: number, route = '00a0') => `018f0000-0000-7000-8000-${route}${String(n).padStart(8, '0')}`;
const author = 'schema:author';
const target = id(9000, '0123');
const role = { property: 'schema:role', in: [id(9001)] };
const language = { property: 'schema:language', in: [id(9002)] };
const relation = (value: string, qualifiers?: IndexedSubject['statements'][number]['qualifiers']) => ({
  property: author,
  value,
  facet: { kind: 'item' as const },
  ...(qualifiers ? { qualifiers } : {}),
});
const book = (n: number, route = '00a0'): IndexedSubject => ({
  id: id(n, route),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [],
  aliases: [],
  descriptions: [],
  statements: Array.from({ length: 128 }, (_, index) => relation(id(index + 1000, '0123'))),
});
const value = (values = [target], qualifiers?: readonly FilterQualifier[]): FilterDocument => ({
  statement: { property: author, in: values, ...(qualifiers ? { qualifiers } : {}) },
});
const type: FilterDocument = { type: { in: ['schema:Book'] } };
const hit = (subject: IndexedSubject, matched: readonly string[] = []): Hit => ({
  id: subject.id,
  partition: subjectPartition(subject.id),
  securityRevision: subject.securityRevision,
  matched,
});
function named(filter: FilterDocument) {
  const { leaves } = compileFilter(filter, { prefix: 'filter.' });
  return {
    clauses: new Map<string, FactClause>(leaves.map((leaf) => [leaf.name, leaf])),
    names: leaves.map((l) => l.name),
  };
}

// Keep the complete facts in the existing fake; only the disclosure read is truncated.
function fixture() {
  const fake = createFakeSource();
  const reads: { partition: number; ids: readonly string[] }[] = [];
  const calls: { partition: number; probes: readonly RelationFacetProbe[] }[] = [];
  let active = 0;
  let peak = 0;
  async function operation<T>(read: () => Promise<T>): Promise<T> {
    active++;
    peak = Math.max(peak, active);
    try {
      await Bun.sleep(1);
      return await read();
    } finally {
      active--;
    }
  }
  const source: SubjectSource = {
    read: (partition, ids) => {
      reads.push({ partition, ids: [...ids] });
      return operation(async () => {
        const snapshot = await fake.read(partition, ids);
        return {
          ...snapshot,
          subjects: snapshot.subjects.map((subject) => ({
            ...subject,
            statements: [
              ...subject.statements.filter((statement) => statement.property !== author),
              ...subject.statements
                .filter((statement) => statement.property === author)
                .slice(0, MAX_RELATION_FACET_VALUES),
            ],
            relationFacetOverflow:
              subject.relationFacetOverflow ??
              (subject.statements.filter((statement) => statement.property === author).length >
              MAX_RELATION_FACET_VALUES
                ? [author]
                : []),
          })),
        };
      });
    },
    count: async () => {
      throw new Error('Disclosure must not count or scan');
    },
    matchRelationFacets: (partition, probes) => {
      calls.push({ partition, probes: structuredClone(probes) });
      return operation(() => fake.matchRelationFacets(partition, probes));
    },
  };
  return { fake, source, reads, calls, peak: () => peak };
}

test('overflow disclosure rechecks complete boolean filters including negation beyond the sampled values', async () => {
  const { fake, source } = fixture();
  const subjects = [1, 2, 3, 4].map((n) => book(n));
  for (const [index, subject] of subjects.entries()) {
    subject.statements.push(relation(index % 2 === 0 ? target : id(9999)));
    if (index >= 2) subject.type = 'schema:Recipe';
    fake.put(subject);
  }
  const cases: { filter: FilterDocument; kept: number[] }[] = [
    { filter: value(), kept: [0, 2] },
    { filter: { not: value() }, kept: [1, 3] },
    { filter: { and: [type, value()] }, kept: [0] },
    { filter: { or: [type, value()] }, kept: [0, 1, 2] },
    { filter: { or: [value(), type] }, kept: [0, 1, 2] },
    { filter: { not: { and: [type, value()] } }, kept: [1, 2, 3] },
    { filter: { not: { or: [type, value()] } }, kept: [3] },
    { filter: { not: { not: value() } }, kept: [0, 2] },
    { filter: { and: [{ not: value() }, type] }, kept: [1] },
    { filter: { or: [{ and: [value(), type] }, { not: type }] }, kept: [0, 2, 3] },
  ];
  for (const { filter, kept } of cases) {
    const { clauses, names } = named(filter);
    // Index lineage may be stale, absent, include text names, or report several OR branches.
    for (const matched of [names, [...names].reverse(), [], ['text.0', ...names]]) {
      const result = await checkHits(
        source,
        subjects.map((s) => hit(s, matched)),
        clauses,
        { filter },
      );
      expect(result.passed.map(({ subject }) => subject.id)).toEqual(kept.map((index) => subjects[index]!.id));
      expect(result.dropped).toBe(subjects.length - kept.length);
    }
  }
});

test('qualified overflow clauses reject before probing even under AND, OR and NOT', async () => {
  const { fake, source, calls } = fixture();
  const split = book(1);
  split.statements.push(
    relation(target, [{ property: role.property, value: role.in[0]! }]),
    relation(target, [{ property: language.property, value: language.in[0]! }]),
  );
  const together = book(2);
  together.statements.push(
    relation(
      target,
      [role, language].map((q) => ({ property: q.property, value: q.in[0]! })),
    ),
  );
  for (const subject of [split, together]) fake.put(subject);
  const qualified = value([target], [role, language]);
  const filters: FilterDocument[] = [
    qualified,
    { not: qualified },
    { and: [type, qualified] },
    { or: [type, qualified] },
    value([target], [language, { ...role, in: [...role.in, ...role.in] }]),
  ];
  for (const filter of filters) {
    const { clauses, names } = named(filter);
    await expect(
      checkHits(
        source,
        [split, together].map((s) => hit(s, names)),
        clauses,
        { filter },
      ),
    ).rejects.toThrow('Qualified relation overflow');
    expect(calls).toEqual([]);
  }
});

test('unqualified overflow probes override stale sampled values', async () => {
  const { fake, source } = fixture();
  const stale = book(3);
  stale.statements.push(relation(id(9999)));
  fake.put(stale);
  const read = source.read;
  source.read = async (partition, ids) => {
    const snapshot = await read(partition, ids);
    return { ...snapshot, subjects: snapshot.subjects.map((s) => ({ ...s, statements: [relation(target)] })) };
  };
  expect((await checkHits(source, [hit(stale)], named(value()).clauses, { filter: value() })).passed).toEqual([]);
  const negative = { not: value() };
  expect((await checkHits(source, [hit(stale)], named(negative).clauses, { filter: negative })).passed).toHaveLength(1);
});

test('nonoverflow values, ranges, units, qualifiers and types use current snapshots without point helpers', async () => {
  const { fake, source, calls } = fixture();
  const a = book(1);
  a.statements = [
    relation(
      target,
      [role, language].map((q) => ({ property: q.property, value: q.in[0]! })),
    ),
    { property: 'schema:datePublished', value: 'year', facet: { kind: 'time', year: 2026 } },
    { property: 'schema:totalTime', value: 'time', facet: { kind: 'quantity', amount: 45, unit: 'unit:MIN' } },
  ];
  const b = { ...a, id: id(2), statements: a.statements.map((s) => ({ ...s, qualifiers: [] })) };
  const c = {
    ...a,
    id: id(3),
    statements: a.statements.map((s) =>
      s.facet?.kind === 'quantity' ? { ...s, facet: { ...s.facet, unit: 'unit:HUR' } } : s,
    ),
  };
  for (const subject of [a, b, c]) fake.put(subject);
  delete source.matchRelationFacets;
  const filter: FilterDocument = {
    and: [
      type,
      value([target], [role, language]),
      { statement: { property: 'schema:datePublished', range: { gte: 2026, lte: 2026 } } },
      { statement: { property: 'schema:totalTime', range: { gte: 30, lte: 60, unit: 'unit:MIN' } } },
    ],
  };
  expect(
    (
      await checkHits(
        source,
        [a, b, c].map((s) => hit(s)),
        named(filter).clauses,
        { filter },
      )
    ).passed.map(({ subject }) => subject.id),
  ).toEqual([a.id]);
  fake.put({ ...a, relationFacetOverflow: [author] });
  expect((await checkHits(source, [hit(a)], named(type).clauses, { filter: type })).passed).toHaveLength(1);
  const range: FilterDocument = { statement: { property: 'schema:datePublished', range: { gte: 2026 } } };
  expect((await checkHits(source, [hit(a)], named(range).clauses, { filter: range })).passed).toHaveLength(1);
  expect(calls).toEqual([]);
});

test('overflow point probes are anchored, deduplicated, bounded and fail closed', async () => {
  const { fake, source, reads, calls } = fixture();
  const subjects = Array.from({ length: 7 }, (_, index) => book(index + 1));
  for (const subject of subjects) {
    subject.statements.push(relation(target));
    fake.put(subject);
  }
  const originalHits = subjects.map((s) => hit(s));
  fake.put({ ...subjects[1]!, visibility: 'hidden' });
  fake.put({ ...subjects[2]!, visibility: 'taken_down' });
  fake.put({ ...subjects[3]!, redirect: subjects[0]!.id });
  fake.put({ ...subjects[4]!, securityRevision: 2 });
  fake.remove(subjects[5]!.id);
  const foreign = book(8, '0123');
  foreign.statements.push(relation(target));
  fake.put(foreign);
  const filter = value([target, target]);
  const { clauses } = named(filter);
  const result = await checkHits(
    source,
    [
      ...originalHits.slice(0, 6),
      originalHits[0]!,
      { ...hit(subjects[6]!), partition: 18 },
      { ...hit(subjects[0]!), id: 'invalid-id' },
      hit(foreign),
    ],
    clauses,
    { filter },
  );
  expect(result.passed.map(({ subject }) => subject.id)).toEqual([subjects[0]!.id, subjects[0]!.id, foreign.id]);
  expect(result.dropped).toBe(7);
  expect(reads).toEqual([
    { partition: 10, ids: subjects.slice(0, 6).map((s) => s.id) },
    { partition: 18, ids: [foreign.id] },
  ]);
  expect(
    calls
      .map(({ partition, probes }) => ({ partition, subjects: probes.map((p) => p.subject) }))
      .sort((a, b) => a.partition - b.partition),
  ).toEqual([
    { partition: 10, subjects: [subjects[0]!.id] },
    { partition: 18, subjects: [foreign.id] },
  ]);
  expect(calls.every(({ partition, probes }) => probes.every((p) => subjectPartition(p.subject) === partition))).toBe(
    true,
  );
});

test('overflow read failures and absent or malformed point results reject the whole page even for negative leaves', async () => {
  for (const failure of ['absent', 'throw', 'short', 'long', 'nonboolean', 'sparse', 'null', 'snapshot'] as const) {
    const { fake, source } = fixture();
    const a = book(1);
    a.statements = [];
    const b = book(2, '0123');
    b.statements.push(relation(target));
    fake.put(a);
    fake.put(b);
    const filter: FilterDocument = { not: value() };
    const { clauses } = named(filter);
    if (failure === 'absent') delete source.matchRelationFacets;
    else if (failure === 'snapshot') {
      const read = source.read;
      source.read = (partition, ids) =>
        partition === 18 ? Promise.reject(new Error('snapshot unavailable')) : read(partition, ids);
    } else
      source.matchRelationFacets = async () => {
        if (failure === 'throw') throw new Error('point unavailable');
        const malformed: unknown =
          failure === 'short'
            ? []
            : failure === 'long'
              ? [false, false]
              : failure === 'nonboolean'
                ? [0]
                : failure === 'sparse'
                  ? Array(1)
                  : null;
        return malformed as boolean[];
      };
    await expect(checkHits(source, [hit(a), hit(b)], clauses, { filter })).rejects.toThrow();
  }
});

test('duplicate leaves reuse unqualified probes while retaining matched clause priority', async () => {
  const { fake, source, calls } = fixture();
  const a = book(1);
  a.statements.push(
    relation(
      target,
      [role, language].map((q) => ({ property: q.property, value: q.in[0]! })),
    ),
  );
  fake.put(a);
  const filter: FilterDocument = {
    or: [value([id(9999), target]), value([target, id(9999), target]), value([id(9998)]), { not: value([target]) }],
  };
  const { clauses, names } = named(filter);
  const result = await checkHits(source, [hit(a, [names[2]!, names[0]!]), hit(a, names)], clauses, { filter });
  expect(result.passed).toHaveLength(2);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.probes).toHaveLength(3);
  expect(calls[0]!.probes[0]!.value).toBe(id(9998));
  expect(new Set(calls[0]!.probes.map((p) => p.value))).toEqual(new Set([id(9999), target, id(9998)]));
});

test('overflow batches exceed 256 only across calls and share bounded concurrency with partition snapshots', async () => {
  const { fake, source, reads, calls, peak } = fixture();
  const subjects = Array.from({ length: 40 }, (_, index) =>
    book(index + 1, ((Math.floor(index / 5) + 1) * 16).toString(16).padStart(4, '0')),
  );
  for (const subject of subjects) {
    subject.statements.push(relation(target));
    fake.put(subject);
  }
  const filter = value([target, ...Array.from({ length: 63 }, (_, index) => id(5000 + index))]);
  const result = await checkHits(
    source,
    subjects.map((s) => hit(s)),
    named(filter).clauses,
    { filter, concurrency: 3 },
  );
  expect(result.passed.map(({ subject }) => subject.id)).toEqual(subjects.map((s) => s.id));
  expect(reads).toHaveLength(8);
  expect(calls).toHaveLength(16);
  for (let partition = 1; partition <= 8; partition++) {
    expect(calls.filter((call) => call.partition === partition).map((call) => call.probes.length)).toEqual([
      MAX_RELATION_FACET_PROBES,
      64,
    ]);
  }
  expect(peak()).toBe(3);
});

test('fixed truncated snapshots keep exact disclosure read and probe counts constant as full relation degree grows', async () => {
  const counts = [];
  for (const degree of [128, 512, 2048]) {
    const { fake, source, reads, calls } = fixture();
    const subjects = Array.from({ length: 5 }, (_, index) => ({
      ...book(index + 1),
      // Fix the snapshot and overflow marker to isolate disclosure work from the stored degree.
      relationFacetOverflow: [author],
      statements: Array.from({ length: degree }, (_, i) => relation(id(i + 1000, '0123'))),
    }));
    for (const subject of subjects) fake.put(subject);
    const filter = value(Array.from({ length: 64 }, (_, i) => id(i + 1000, '0123')));
    const result = await checkHits(
      source,
      subjects.map((s) => hit(s)),
      named(filter).clauses,
      { filter },
    );
    expect(result.passed).toHaveLength(5);
    counts.push({
      reads: reads.length,
      batches: calls.map((c) => c.probes.length),
      probes: calls.flatMap((c) => c.probes).length,
    });
  }
  expect(counts).toEqual(Array.from({ length: 3 }, () => ({ reads: 1, batches: [256, 64], probes: 320 })));
});

test('257 same-home candidates keep bounded reads, reject accounting, Boolean probes and stable duplicates', async () => {
  const { fake, source, reads, calls } = fixture();
  const subjects = Array.from({ length: 257 }, (_, index) => book(index + 1));
  for (const subject of subjects) {
    subject.statements.push(relation(target));
    fake.put(subject);
  }
  fake.put({ ...subjects[255]!, visibility: 'hidden' });
  const filter: FilterDocument = { or: [value([target]), { not: type }] };
  const result = await checkHits(source, [...subjects.map((s) => hit(s)), hit(subjects[0]!)], named(filter).clauses, {
    filter,
    concurrency: 1,
  });
  expect(result.passed.map(({ subject }) => subject.id)).toEqual([
    ...subjects.filter((_, index) => index !== 255).map((s) => s.id),
    subjects[0]!.id,
  ]);
  expect(result.dropped).toBe(1);
  expect(reads.map((read) => read.ids.length)).toEqual([256, 1]);
  expect(calls.map((call) => call.probes.length)).toEqual([256]);
  expect(calls[0]!.probes.map((probe) => probe.subject)).toEqual(subjects.filter((_, i) => i !== 255).map((s) => s.id));
});

test('invalid overflow observation rejects before a point probe even when its candidate would be dropped', async () => {
  const { fake, source, calls } = fixture();
  const a = book(1),
    b = book(2);
  a.statements.push(relation(target));
  fake.put(a);
  fake.put({ ...b, visibility: 'hidden' });
  const read = source.read;
  source.read = async (partition, ids) => {
    const snapshot = await read(partition, ids);
    return { ...snapshot, subjects: [...snapshot.subjects, { ...b, securityRevision: -1 }] };
  };
  await expect(checkHits(source, [hit(a), hit(b)], named(value()).clauses, { filter: value() })).rejects.toThrow();
  expect(calls).toEqual([]);
});
