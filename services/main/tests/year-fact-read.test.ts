import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { template } from '../src/modules/query/templates/work-publication-years.schema.ts';
import {
  invertedPublicationYear, keepPublicationRow, publicationCalendarYear, publicationRowKey,
  publicationYearBoundsError, publicationYearFromKey,
} from '../src/modules/query/year-fact.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const request = (parameters: Record<string, unknown>) => ({
  profile: 'template-query-v1', query: template.query, revision: 1, parameters,
});

describe('first-publication year page', () => {
  test('accepts an optional inclusive year range and rejects a page or an injected query', () => {
    expect(Value.Check(template.request, request({}))).toBe(true);
    expect(Value.Check(template.request, request({ fromYear: 1999, toYear: 2024 }))).toBe(true);
    expect(Value.Check(template.request, { ...request({ fromYear: 7 }), limit: 64, cursor: 'retained-cursor' })).toBe(true);
    for (const parameters of [{ fromYear: 0 }, { toYear: 10000 }, { fromYear: 1.5 }, { roots: ['https://rezics.com/id/11111111-1111-4111-8111-111111111111'] }])
      expect(Value.Check(template.request, request(parameters))).toBe(false);
    expect(Value.Check(template.request, { ...request({}), page: { size: 20 } })).toBe(false);
    expect(Value.Check(template.request, { ...request({}), sparql: 'SELECT * WHERE { ?s ?p ?o }' })).toBe(false);
    expect(publicationYearBoundsError(2025, 2020)).toBe('publication year range is empty');
    expect(publicationYearBoundsError(1999, 2024)).toBeNull();
    expect(template.scope).toBe('public');
    expect(template.eligibility.kind).toBe('first-publication');
  });

  test('reads the calendar year of a date, a zoned dateTime and a gYear', () => {
    expect(publicationCalendarYear(`${XSD}date`, '2024-06-01')).toBe(2024);
    expect(publicationCalendarYear(`${XSD}dateTime`, '1999-12-31T23:00:00-05:00')).toBe(1999);
    expect(publicationCalendarYear(`${XSD}gYear`, '0007')).toBe(7);
    expect(publicationCalendarYear(`${XSD}date`, '2024-02-29')).toBe(2024);
    for (const [datatype, lexical] of [
      [`${XSD}date`, '2024-13-01'], [`${XSD}date`, '2023-02-29'], [`${XSD}gYear`, '0000'],
      [`${XSD}gYear`, '10000'], [`${XSD}gYear`, '1999Z'], [`${XSD}dateTime`, '1999-12-31T23:00:00-05:00Z'],
      [`${XSD}string`, '2024'],
    ] as const) expect(publicationCalendarYear(datatype, lexical)).toBeNull();
  });

  test('orders an inverted year key before the work id, newest first', () => {
    const works = [
      { year: 7, id: 'https://rezics.com/id/33333333-3333-4333-8333-333333333331' },
      { year: 2024, id: 'https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' },
      { year: 2024, id: 'https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' },
      { year: 1999, id: 'https://rezics.com/id/22222222-2222-4222-8222-222222222221' },
    ];
    expect(invertedPublicationYear(9999)).toBe('0001');
    expect(invertedPublicationYear(1)).toBe('9999');
    expect(invertedPublicationYear(2024)).toBe('7976');
    expect(invertedPublicationYear(7)).toBe('9993');
    expect(publicationYearFromKey('7976')).toBe(2024);
    const ordered = works.map(work => ({ ...work, key: invertedPublicationYear(work.year) }))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1);
    expect(ordered.map(work => work.year)).toEqual([2024, 2024, 1999, 7]);
    expect(ordered.map(work => work.id).slice(0, 2)).toEqual([
      'https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    ]);
    const seen = new Set<string>();
    const rows = [
      { id: ordered[0]!.id, year: '2024', statement: 'one' },
      { id: ordered[0]!.id, year: '2024', statement: 'two' },
      { id: ordered[0]!.id, year: '1990', statement: 'other' },
    ];
    expect(rows.filter(row => keepPublicationRow(seen, row.id, row.year)).map(row => row.statement)).toEqual(['one', 'other']);
    expect(publicationRowKey(rows[0]!.id, '2024')).toBe(`${rows[0]!.id}\0${'2024'}`);
  });
});
