import { expect, test } from 'bun:test';
import type { DiscoveryFilterDocument, FilterRelease } from '@rezics/filter';
import { projectCharacterPersonContexts, type CurrentRelationRelease } from '../../src/search/character-person.ts';
import type { IndexedStatement, IndexedSubject, RelationFacetProbe, SubjectSource } from '../../src/search/source.ts';

const id = (n: number, route: string) => `018f0000-0000-7000-8000-${route}${String(n).padStart(8, '0')}`;
const personId = id(1, '00a0');
const works = [1, 2, 3, 4].map((n) => id(n, '00b0'));
const release: FilterRelease = {
  types: { 'schema:Person': {} },
  properties: { 'wdt:P725': { datatype: 'wikibase-item', relation: { group: 'credit' } } },
};
const active = (): CurrentRelationRelease => ({ digest: 'release-a', head: 1, release });

function subject(id: string, statements: IndexedStatement[] = []): IndexedSubject {
  return {
    id,
    type: id === personId ? 'schema:Person' : 'schema:Movie',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: `Work ${id.slice(-2)}` }],
    aliases: [{ language: 'en', value: `Alias ${id.slice(-2)}` }],
    descriptions: [],
    statements,
  };
}

function fixture() {
  let position = 1n;
  const rows = new Map<string, IndexedSubject>([
    [personId, subject(personId)],
    ...works.map((work) => [work, subject(work, [{ property: 'wdt:P725', value: personId }])] as const),
  ]);
  const source: SubjectSource = {
    async read(partition, ids) {
      return {
        partition,
        position,
        subjects: ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : [])),
      };
    },
    async count() {
      return { position, count: rows.size };
    },
    async matchRelationFacets(_partition, probes: readonly RelationFacetProbe[]) {
      return probes.map((probe) =>
        (rows.get(probe.subject)?.statements ?? []).some(
          (statement) => statement.property === probe.property && statement.value === probe.value,
        ),
      );
    },
  };
  return { source, advance: () => (position += 1n) };
}

const filter: DiscoveryFilterDocument = {
  statement: { property: 'wdt:P725', inverse: true, in: works },
};

test('current Person contexts are capped, localized, and report continuation truthfully', async () => {
  const f = fixture();
  const contexts = await projectCharacterPersonContexts(f.source, { id: personId, type: 'schema:Person' }, filter, {
    languages: ['en'],
    spoilerThreshold: 1,
    observeRelationRelease: async () => active(),
  });
  expect(contexts).toEqual({
    credits: {
      items: works.slice(0, 3).map((work) => ({
        id: work,
        labels: { en: `Work ${work.slice(-2)}` },
        aliases: { en: [`Alias ${work.slice(-2)}`] },
      })),
      next: true,
    },
    appearances: { items: [], next: false },
  });
});

test('context windows retire when a touched work changes during disclosure', async () => {
  const f = fixture();
  const match = f.source.matchRelationFacets!;
  f.source.matchRelationFacets = async (partition, probes) => {
    const result = await match(partition, probes);
    f.advance();
    return result;
  };
  await expect(
    projectCharacterPersonContexts(f.source, { id: personId, type: 'schema:Person' }, filter, {
      languages: ['en'],
      observeRelationRelease: async () => active(),
    }),
  ).resolves.toBeNull();
});
