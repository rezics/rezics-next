import { expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import {
  matchInverseRelationFacets,
  withCurrentRelationRelease,
  type CurrentRelationRelease,
} from '../../src/search/character-person.ts';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import type { IndexedStatement, IndexedSubject, RelationFacetProbe, SubjectSource } from '../../src/search/source.ts';

const id = (n: number, route = '00a0') => `018f0000-0000-7000-8000-${route}${String(n).padStart(8, '0')}`;
const property = 'wdt:P725';
const role = 'wdt:P3831';
const character = 'wdt:P453';
const release: FilterRelease = {
  types: { 'schema:Movie': { facets: [property] }, 'schema:Person': {} },
  properties: {
    [property]: { datatype: 'wikibase-item', qualifiers: [role, character], relation: { group: 'credit' } },
    [role]: { datatype: 'wikibase-item' },
    [character]: { datatype: 'wikibase-item' },
  },
};
const credit = (part: string, portrayed: string): IndexedStatement => ({
  property,
  value: id(1),
  qualifiers: [
    { property: role, value: part },
    { property: character, value: portrayed },
  ],
});
const candidate = (): IndexedSubject => ({
  id: id(1),
  type: 'schema:Person',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [],
  aliases: [],
  descriptions: [],
  statements: [],
});
const active = (): CurrentRelationRelease => ({ digest: 'release-a', head: 1, release });

test('release loss, replacement and returning to the same digest retire foreign disclosure', async () => {
  for (const replacement of [null, { ...active(), digest: 'release-b' }, { ...active(), head: 3 }]) {
    let current: CurrentRelationRelease | null = active();
    expect(
      await withCurrentRelationRelease(
        async () => current,
        async () => {
          current = replacement;
          return [id(1)];
        },
        [],
      ),
    ).toEqual([]);
  }
  expect(
    await withCurrentRelationRelease(
      async () => active(),
      async () => [id(1)],
      [],
    ),
  ).toEqual([id(1)]);
  let called = false;
  expect(
    await withCurrentRelationRelease(
      async () => null,
      async () => {
        called = true;
        return [id(1)];
      },
      [],
    ),
  ).toEqual([]);
  expect(called).toBe(false);
});

function fixture() {
  let subject = candidate();
  let position = 1n;
  let current = active();
  const calls: { partition: number; probes: readonly RelationFacetProbe[] }[] = [];
  const works = new Map<string, IndexedStatement[]>([
    [id(10, '00b0'), [credit(id(3), id(4)), credit(id(5), id(6))]],
    [id(11, '00c0'), [credit(id(3), id(6))]],
  ]);
  const source: SubjectSource = {
    read: async () => ({ partition: 10, position, subjects: [subject] }),
    count: async () => ({ position, count: 1 }),
    async matchRelationFacets(partition, probes) {
      calls.push({ partition, probes });
      return probes.map((probe) =>
        holdsCurrentStatements(works.get(probe.subject) ?? [], {
          facet: 'statement',
          property: probe.property,
          values: [probe.value],
          ...(probe.qualifiers ? { qualifiers: probe.qualifiers } : {}),
        }),
      );
    },
  };
  return {
    source,
    calls,
    observe: async () => current,
    replace: (next: Partial<IndexedSubject>) => {
      subject = { ...subject, ...next };
    },
    advance: () => {
      position++;
    },
    release: () => {
      current = { ...current, head: current.head + 1 };
    },
  };
}
const probe = (part: string, portrayed: string, source = id(10, '00b0')) => ({
  subject: id(1),
  source,
  property,
  qualifiers: [
    { property: role, in: [part] },
    { property: character, in: [portrayed] },
  ],
});

test('inverse selected works preserve repeated voice credits and constrain one statement at a time', async () => {
  const f = fixture();
  const first = probe(id(3), id(4));
  const probes = [first, probe(id(3), id(6)), probe(id(5), id(6)), first, probe(id(3), id(6), id(11, '00c0'))];
  const result = await matchInverseRelationFacets(f.source, 10, probes, f.observe);
  expect(result).toEqual([true, 'not_proven', true, true, true]);
  expect(f.calls.map(({ partition, probes }) => [partition, probes.length])).toEqual([
    [11, 3],
    [12, 1],
  ]);
  expect(f.calls[0]!.probes[0]).toEqual({
    subject: first.source,
    property,
    value: first.subject,
    qualifiers: first.qualifiers,
  });
  const negative = compileCurrentFilter({ not: { statement: { property, in: [id(1)] } } });
  expect(negative.evaluate([result[1]!])).toBe('not_proven');
});

test('inverse witnesses retire when result anchors or the runtime release change during foreign checks', async () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => f.replace({ visibility: 'hidden' }),
    (f: ReturnType<typeof fixture>) => f.replace({ redirect: id(2) }),
    (f: ReturnType<typeof fixture>) => f.replace({ securityRevision: 2 }),
    (f: ReturnType<typeof fixture>) => f.advance(),
    (f: ReturnType<typeof fixture>) => f.release(),
  ]) {
    const f = fixture();
    const match = f.source.matchRelationFacets!;
    f.source.matchRelationFacets = async (partition, probes) => {
      const result = await match(partition, probes);
      mutation(f);
      return result;
    };
    expect(await matchInverseRelationFacets(f.source, 10, [probe(id(3), id(4))], f.observe)).toEqual(['not_proven']);
  }
});

test('invalid inverse requests reject before reads and unavailable or malformed evidence cannot become a negative', async () => {
  const f = fixture();
  const valid = probe(id(3), id(4));
  for (const invalid of [
    { ...valid, source: 'bad' },
    { ...valid, subject: id(1, '00b0') },
    { ...valid, qualifiers: [] },
  ])
    await expect(matchInverseRelationFacets(f.source, 10, [invalid], f.observe)).rejects.toThrow(
      'Invalid inverse relation probe',
    );
  await expect(matchInverseRelationFacets(f.source, 10, Array(257).fill(valid), f.observe)).rejects.toThrow();
  expect(f.calls).toEqual([]);
  f.source.matchRelationFacets = async () => [];
  await expect(matchInverseRelationFacets(f.source, 10, [valid], f.observe)).rejects.toThrow(
    'Malformed relation facet probe results',
  );
  delete f.source.matchRelationFacets;
  expect(await matchInverseRelationFacets(f.source, 10, [valid], f.observe)).toEqual(['not_proven']);
});
