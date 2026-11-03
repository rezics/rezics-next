import { expect, test } from 'bun:test';
import { calendarInterval, type CalendarDate } from '@rezics/filter';
import { compileFilter } from '../../src/search/filter.ts';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import { documentActions } from '../../src/search/document.ts';
import { calendarIndexDefinition, hasCalendarIndexFormat } from '../../src/search/release-search-calendar.ts';
import { subjectIndexDefinition } from '../../src/search/indices.ts';
import { subjectPartition, type IndexedStatement } from '../../src/search/source.ts';

const property = 'schema:datePublished';
const range = { type: 'time' as const, gte: '2024-02-29', lte: '2024-03' };
const filter = { statement: { property, range } };
const statement = (date?: CalendarDate): IndexedStatement => ({
  property,
  value: 'native time',
  ...(date ? { facet: { kind: 'time', ...date } } : {}),
});

test('candidate overlap is same-statement and cannot run on an unprepared year-only generation', () => {
  expect(() => compileFilter(filter, { prefix: 'f' })).toThrow('requires a prepared physical generation');
  const compiled = compileFilter(filter, { prefix: 'f', calendarFormat: 1 });
  expect(compiled.query).toEqual({
    nested: {
      path: 'facts',
      score_mode: 'none',
      _name: 'f0',
      query: {
        bool: {
          filter: [
            { term: { 'facts.property': property } },
            { range: { 'facts.time_upper': { gte: calendarInterval({ year: 2024, month: 2, day: 29 }).lower } } },
            { range: { 'facts.time_lower': { lte: calendarInterval({ year: 2024, month: 3 }).upper } } },
          ],
        },
      },
    },
  });
  const clause = compiled.leaves[0]!;
  if (clause.facet !== 'statement') throw new Error('Expected statement');
  for (const date of [{ year: 2024 }, { year: 2024, month: 2 }, { year: 2024, month: 3, day: 31 }])
    expect(holdsCurrentStatements([statement(date)], clause)).toBe(true);
  for (const date of [undefined, { year: 2024, month: 2, day: 28 }, { year: 2023 }])
    expect(holdsCurrentStatements([statement(date)], clause)).toBe(false);
  const plan = compileCurrentFilter({ or: [filter, { not: { statement: { property, range: { gte: 2024 } } } }] });
  expect(plan.leaves).toHaveLength(2);
  expect(plan.evaluate(['not_proven', true])).toBe('not_proven');
});

test('successor projection retains precision and distinct dates while historical projection stays unchanged', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const snapshot = {
    partition: subjectPartition(id),
    position: 1n,
    subjects: [
      {
        id,
        type: 'schema:Release',
        visibility: 'visible' as const,
        redirect: null,
        securityRevision: 1,
        labels: [],
        aliases: [],
        descriptions: [],
        statements: [
          statement({ year: 2024 }),
          statement({ year: 2024, month: 2 }),
          statement({ year: 2024, month: 2, day: 29 }),
          statement({ year: 2024, month: 2, day: 29 }),
          statement(),
        ],
      },
    ],
  };
  const old = documentActions(snapshot, [id])[0]!;
  const next = documentActions(snapshot, [id], undefined, 1)[0]!;
  if (old.op !== 'index' || next.op !== 'index') throw new Error('Expected documents');
  expect(old.document.facts).toEqual([{ property, year: 2024, qualifiers: [] }]);
  expect(next.document.facts).toHaveLength(3);
  expect(next.document.facts[0]).not.toHaveProperty('month');
  expect(next.document.facts[1]).toMatchObject({ month: 2 });
  expect(next.document.facts[1]).not.toHaveProperty('day');
  expect(next.document.facts[2]).toMatchObject({
    day: 29,
    time_lower: calendarInterval({ year: 2024, month: 2, day: 29 }).lower,
  });
  const base = subjectIndexDefinition();
  const successor = calendarIndexDefinition(base);
  expect(hasCalendarIndexFormat(base.mappings)).toBe(false);
  expect(hasCalendarIndexFormat(successor.mappings)).toBe(true);
  const forged = structuredClone(base) as any;
  forged.mappings._meta.calendar_range_format = 1;
  expect(hasCalendarIndexFormat(forged.mappings)).toBe(false);
});
