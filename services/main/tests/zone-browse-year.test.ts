import { withFixtureRealmDisclosure } from './support/disclosure-ancestry.ts';
import { expect, test } from 'bun:test';
import { compileZoneBrowse, readZoneBrowse } from '../src/modules/zone-modules/browse.ts';
import { compileQuery, QueryRejected } from '../src/modules/query/compile.ts';
import { compileFacet } from '../../../model/compiler/facet.ts';
import { publicationYearFacet } from '../../../model/definitions/facet-publication-year-v1.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000009000';

test('Zone browse admits a publication year or inclusive bounded range in its compiled request', () => {
  for (const publicationYear of ['1', '1995', '9999', '1990-2000', '1-9999']) {
    const plan = compileZoneBrowse(realm, { publicationYear });
    if (plan.template !== 'zone-browse') throw new Error('Expected Realm browse plan');
    expect(plan.request.publicationYear).toBe(publicationYear);
    const [min, max = min] = publicationYear.split('-');
    const equivalent = compileQuery({
      profile: 'filter-document-v2',
      context: { realm },
      scope: { kind: 'realm', realm },
      sort: 'newest',
      page: { size: 20 },
      filter: { all: [{ facet: 'publicationYear', range: { min, max } }] },
    });
    if (equivalent.template !== 'zone-browse') throw new Error('Expected Realm browse plan');
    expect(plan).toEqual(equivalent);
  }
});

test('the publication-year Facet preserves its global calendar-year path and bounded integer domain', () => {
  expect(compileFacet(publicationYearFacet)).toMatchObject({
    path: [{ kind: 'publication-year' }],
    source: 'global',
    values: [
      {
        kind: 'datatype',
        datatype: 'http://www.w3.org/2001/XMLSchema#integer',
        min: '1',
        max: '9999',
      },
    ],
  });
  expect(() => compileFacet({ ...publicationYearFacet, source: 'context' })).toThrow(
    'global accepted calendar years',
  );
  expect(() =>
    compileFacet({
      ...publicationYearFacet,
      values: [{ kind: 'datatype', datatype: 'xsd:integer', min: '0', max: '9999' }],
    }),
  ).toThrow('global accepted calendar years');
});

test('admitted integer lexical variants compile to the browse adapter canonical year', () => {
  const plan = compileQuery({
    profile: 'filter-document-v2',
    context: { realm },
    scope: { kind: 'realm', realm },
    sort: 'newest',
    page: { size: 20 },
    filter: { all: [{ facet: 'publicationYear', range: { min: '01995', max: '001995' } }] },
  });
  if (plan.template !== 'zone-browse') throw new Error('Expected Realm browse plan');
  expect(plan.request.publicationYear).toBe('1995');
  expect(compileZoneBrowse(realm, plan.request)).toEqual(plan);
});

test('invalid publication years refuse before reading Realm visibility or the graph', async () => {
  const unread = {
    realm: async () => {
      throw new Error('owner read before admission');
    },
    query: async () => {
      throw new Error('graph read before admission');
    },
  } as unknown as WorkReadSession;
  for (const publicationYear of [
    '',
    '0',
    '10000',
    '1995.5',
    '1995-',
    '-1995',
    '2000-1990',
    '0-1995',
    '1995-10000',
    '1995-1996-1997',
    '1995) UNION {}',
  ]) {
    await expect(readZoneBrowse(unread, realm, { publicationYear })).rejects.toBeInstanceOf(
      QueryRejected,
    );
  }
});

test('shared Query admission refuses invalid, unsupported and duplicate publication-year Conditions', () => {
  for (const all of [
    [{ facet: 'publicationYear', range: { min: '0' } }],
    [{ facet: 'publicationYear', range: { max: '10000' } }],
    [{ facet: 'publicationYear', range: { min: '1995.5' } }],
    [{ facet: 'publicationYear', range: { min: '2000', max: '1995' } }],
    [{ facet: 'publicationYear', any: ['1995'] }],
    [
      { facet: 'publicationYear', range: { min: '1995' } },
      { facet: 'publicationYear', range: { max: '2000' } },
    ],
  ]) {
    expect(() =>
      compileQuery({
        profile: 'filter-document-v2',
        context: { realm },
        scope: { kind: 'realm', realm },
        sort: 'newest',
        page: { size: 20 },
        filter: { all },
      }),
    ).toThrow(QueryRejected);
  }
});

const reference = (index: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const term = (value: string) => ({ value });
function browseSession(count = 310, firstMatch = 300, cursor?: string) {
  const entries = Array.from({ length: count }, (_, index) => ({
    work: reference(index),
    adoptedOrder: String(count - index),
    words: null,
    updatedAt: null,
  }));
  const batches: number[] = [];
  const queries: string[] = [];
  const session = {
    options: { limit: 20, cursor },
    position: { dataEpoch: 'epoch', sequence: '1' },
    checkDeadline: () => {},
    observeDependency: () => {},
    realm: async () => ({ visibility: 'public', realmRevision: reference(999) }),
    query: async (sparql: string) => {
      queries.push(sparql);
      const ids = [...sparql.matchAll(/<(https:\/\/rezics\.com\/id\/[^>]+)>/g)]
        .map((match) => match[1]!)
        .filter((value) => entries.some((entry) => entry.work === value));
      if (sparql.includes('?evidence'))
        return [...new Set(ids)]
          .filter((work) => Number(work.slice(-12)) >= firstMatch)
          .map((work) => {
            return {
              work: term(work),
              head: term(reference(991)),
              main: term(reference(992)),
              evidence: term(reference(993)),
              revisionEpoch: term('epoch'),
              sequence: term('1'),
            };
          });
      if (sparql.includes('SELECT ?work ?type'))
        return ids.map((work) => ({ work: term(work), type: term('https://schema.org/Book') }));
      if (sparql.includes('SELECT ?work ?head')) return ids.map((work) => ({ work: term(work) }));
      return [];
    },
    summaries: async (ids: string[]) =>
      ids.map((work) => ({
        status: 'available',
        disclosure: 'public',
        type: 'work',
        name: { value: work, language: 'en', direction: 'ltr', basis: 'requested' },
        avatar: { kind: 'fallback', policy: 'test', key: work, resourceType: 'work' },
      })),
    deps: {
      zoneBrowse: {
        current: async () => true,
        batch: async (_realm: string, _sort: string, after: { key: string | null } | null) => {
          const rows = entries
            .filter((entry) => !after || Number(entry.adoptedOrder) < Number(after.key))
            .slice(0, 64);
          batches.push(rows.length);
          return rows;
        },
      },
      discovery: { active: async () => ({ stale: false }), workTerms: async () => [] },
    },
  } as unknown as WorkReadSession;
  return { session: withFixtureRealmDisclosure(session), batches, queries };
}

test('a year match beyond member 300 remains reachable after an empty bounded page', async () => {
  const firstFixture = browseSession();
  const first = await readZoneBrowse(firstFixture.session, realm, { publicationYear: '1995' });
  expect(first.items).toEqual([]);
  expect(first.matches).toEqual({ value: 0, kind: 'lower-bound' });
  expect(first.nextCursor).toBeTruthy();
  expect(firstFixture.batches).toEqual([64, 64, 64, 64]);
  const second = await readZoneBrowse(browseSession(310, 300, first.nextCursor!).session, realm, {
    publicationYear: '1995',
  });
  expect(second.items.map((item) => item.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => reference(300 + index)),
  );
  expect(second.matches).toEqual({ value: 10, kind: 'exact' });
  expect(second.nextCursor).toBeNull();
});

test('the year predicate binds the Statement meaning key before it asks for acceptance', async () => {
  const fixture = browseSession();
  await readZoneBrowse(fixture.session, realm, { publicationYear: '1995' });
  const filters = fixture.queries.filter((sparql) => sparql.includes('YEAR(?published)'));
  expect(filters.length).toBeGreaterThan(0);
  for (const sparql of filters) {
    // A Statement without a meaning key has no exact acceptance to match.
    expect(sparql).toContain('rv:meaningKey ?yearkey');
    expect(sparql.indexOf('rv:meaningKey ?yearkey')).toBeLessThan(sparql.indexOf('rv:acceptanceContext'));
  }
});

test('the fallback removes the new all-years directory control from Main admission', () => {
  expect(() =>
    compileZoneBrowse(realm, {
      publicationYear: '1-9999',
      publicationYearOrder: 'descending',
    } as never),
  ).toThrow(QueryRejected);
});
