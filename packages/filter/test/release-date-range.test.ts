import { expect, test } from 'bun:test';
import {
  admitFilter,
  calendarInterval,
  calendarRangeBounds,
  calendarRangeMatches,
  readCalendarDate,
  readNativeCalendarDate,
  parseFilter,
  type FilterRelease,
} from '../src/index.ts';

test('partial dates overlap inclusive/open boundaries without becoming exact dates', () => {
  const range = { gte: '2024-02-29', lte: '2024-03' };
  for (const value of ['2024', '2024-02', '2024-02-29', '2024-03-31'])
    expect(calendarRangeMatches(readCalendarDate(value), range)).toBe(true);
  for (const value of ['2024-02-28', '2024-04', '2023'])
    expect(calendarRangeMatches(readCalendarDate(value), range)).toBe(false);
  expect(calendarRangeMatches(undefined, range)).toBe(false);
  expect(calendarRangeMatches(readCalendarDate('2024-03'), { gte: '2024-03-31' })).toBe(true);
  expect(calendarRangeMatches(readCalendarDate('2024-03'), { lte: '2024-03-01' })).toBe(true);
  expect(readCalendarDate('2024-02')).toEqual({ year: 2024, month: 2 });
  for (const range of [{}, { gte: '2024-03', lte: '2024-02' }, { gte: '2023-02-29' }, { lte: '2024-13' }])
    expect(calendarRangeBounds(range)).toBeUndefined();
});

const release: FilterRelease = {
  types: { 'schema:Release': { facets: ['schema:datePublished', 'schema:rating'] } },
  properties: {
    'schema:datePublished': { datatype: 'time' },
    'schema:rating': { datatype: 'quantity', units: ['years'] },
  },
  filters: {
    'test/date': {
      filter: { statement: { property: 'schema:datePublished', range: { type: 'time', gte: '2024-02-29' } } },
    },
  },
};
const dateFilter = (range: unknown, property = 'schema:datePublished') => ({ statement: { property, range } });

test('typed calendar ranges survive Boolean/saved expansion without changing numeric meanings', () => {
  const precise = dateFilter({ type: 'time', gte: '2024-02-29', lte: '2024-03' });
  const parsed = parseFilter({ or: [precise, { not: { saved: 'test/date' } }] });
  expect<unknown>(admitFilter(parsed, release)).toEqual({
    or: [precise, { not: dateFilter({ type: 'time', gte: '2024-02-29' }) }],
  });
  for (const range of [
    { type: 'time', lte: '2024-02' },
    { gte: 2024, lte: 2025 },
  ])
    expect<unknown>(admitFilter(parseFilter(dateFilter(range)), release)).toEqual(dateFilter(range));
  const quantity = dateFilter({ gte: 18, unit: 'years' }, 'schema:rating');
  expect<unknown>(admitFilter(parseFilter(quantity), release)).toEqual(quantity);
  expect(() => admitFilter(parseFilter(dateFilter({ type: 'time', gte: '2024' }, 'schema:rating')), release)).toThrow();
});

test('calendar admission rejects malformed, impossible, reversed or mixed operands before any engine', () => {
  for (const range of [
    { type: 'time' },
    { type: 'date', gte: '2024' },
    { type: 'time', gte: 2024 },
    { type: 'time', gte: '2023-02-29' },
    { type: 'time', gte: '2024-03', lte: '2024-02' },
    { type: 'time', gte: '2024-01-01T00:00:00Z' },
    { type: 'time', gte: '2024', unit: 'years' },
    { gte: '2024-02' },
  ])
    expect(() => parseFilter(dateFilter(range))).toThrow();
  const endpoint = {
    type: 'time',
    get gte(): string {
      throw new Error('accessor ran');
    },
  };
  expect(() => parseFilter(dateFilter(endpoint))).toThrow(/invalid_type/);
});

test('Gregorian validation handles leap centuries, signed years, extremes and malformed inputs', () => {
  for (const date of ['0000-02-29', '-0400-02-29', '2000-02-29', '2400-02-29'])
    expect(readCalendarDate(date)).toBeDefined();
  for (const date of [
    '1900-02-29',
    '-0100-02-29',
    '2024-04-31',
    '2024-00',
    '2024-01-00',
    '2024-1',
    '2024-01-01T00:00:00Z',
    '2024\n',
    '9007199254740992',
    2024,
    null,
  ])
    expect(readCalendarDate(date)).toBeUndefined();
  const years = [-Number.MAX_SAFE_INTEGER, -500, 0, 99, 2024, Number.MAX_SAFE_INTEGER];
  const keys = years.map((year) => calendarInterval({ year }).lower);
  expect([...keys].sort()).toEqual(keys);
});

test('native zero components and precision must agree; unsupported evidence remains unknown', () => {
  const native = {
    calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    time: '-0500-00-00T00:00:00Z',
    precision: 9,
  };
  expect(readNativeCalendarDate(native)).toEqual({ year: -500 });
  expect(readNativeCalendarDate({ ...native, time: '+2024-02-00T00:00:00Z', precision: 10 })).toEqual({
    year: 2024,
    month: 2,
  });
  expect(readNativeCalendarDate({ ...native, time: '+2024-02-29T00:00:00Z', precision: 11 })).toEqual({
    year: 2024,
    month: 2,
    day: 29,
  });
  for (const change of [
    { precision: 11 },
    { precision: undefined },
    { calendarmodel: 'Julian' },
    { time: '+2024-01-01T00:00:00Z' },
    { time: '+2024-00-00T00:00:00Zjunk' },
  ])
    expect(readNativeCalendarDate({ ...native, ...change })).toBeUndefined();
});
