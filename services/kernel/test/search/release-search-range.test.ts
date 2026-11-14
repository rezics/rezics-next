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

test('canonical projection retains precision and distinct dates and requires complete mapping fields', () => {
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
  const action = documentActions(snapshot, [id])[0]!;
  if (action.op !== 'index') throw new Error('Expected document');
  expect(action.document.facts).toHaveLength(3);
  expect(action.document.facts[0]).toEqual({
    property,
    year: 2024,
    time_lower: calendarInterval({ year: 2024 }).lower,
    time_upper: calendarInterval({ year: 2024 }).upper,
    qualifiers: [],
  });
  expect(action.document.facts[1]).toMatchObject({ month: 2 });
  expect(action.document.facts[1]).not.toHaveProperty('day');
  expect(action.document.facts[2]).toMatchObject({
    day: 29,
    time_lower: calendarInterval({ year: 2024, month: 2, day: 29 }).lower,
  });
  const base = subjectIndexDefinition();
  expect(hasCalendarIndexFormat(base.mappings)).toBe(true);
  expect(calendarIndexDefinition(base)).toEqual(base);
  const incomplete = structuredClone(base) as any;
  delete incomplete.mappings.properties.facts.properties.time_upper;
  expect(hasCalendarIndexFormat(incomplete.mappings)).toBe(false);
});
