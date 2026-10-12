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
