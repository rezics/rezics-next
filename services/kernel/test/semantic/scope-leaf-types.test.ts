import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import { Pool } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import { normalizeSourceStatement } from '../../src/semantic/scope-leaf-selection.ts';
import { readScopeLeafEvidence, type LeafReader, type LeafWork } from '../../src/semantic/scope-leaf-evidence.ts';

test('invalid native leaf work is rejected before Access preparation or SQL and the shared types have one source', async () => {
  const pool = new Pool({ connectionString: 'postgresql://127.0.0.1:1/unused', connectionTimeoutMillis: 50, max: 1 });
  const access = createAccess({ actions: new Map([['subject:read', { anonymous: true }]]) });
  const reader: LeafReader = readScopeLeafEvidence;
  const budget: LeafWork = { keys: 17, points: 512, witnesses: 16, rows: 2048, bytes: 262144, emptySeeks: 512 };
  try {
    for (const field of Object.keys(budget) as (keyof LeafWork)[]) {
      for (const value of [0, -1, 0.5, NaN, Infinity]) {
        await expect(
          reader(
            pool,
            {
              subject: '019a1b2c-3d4e-7f00-8a00-750000000083',
              leaf: { facet: 'type', values: ['schema:Book'] },
              after: null,
              revalidate: null,
              budget: { ...budget, [field]: value },
            },
            {
              access,
              actor: { kind: 'anonymous' },
              routeKey: new Uint8Array(32).fill(83),
              deadline: Date.now() + 1000,
            },
          ),
        ).rejects.toBeInstanceOf(RangeError);
        expect(pool.totalCount).toBe(0);
      }
    }
    for (const excess of [{ keys: 102 }, { witnesses: 101 }]) {
      await expect(
        reader(
          pool,
          {
            subject: '019a1b2c-3d4e-7f00-8a00-750000000083',
            leaf: { facet: 'type', values: ['schema:Book'] },
            after: null,
            revalidate: null,
            budget: { ...budget, ...excess },
          },
          { access, actor: { kind: 'anonymous' }, routeKey: new Uint8Array(32).fill(83), deadline: Date.now() + 1000 },
        ),
      ).rejects.toBeInstanceOf(RangeError);
      expect(pool.totalCount).toBe(0);
    }
  } finally {
    await pool.end();
  }
});

test('Semantic value projections preserve exact decimals and uncertainty through the current Boolean matcher', () => {
  const properties = {
    'ex:measure': { datatype: 'quantity', qualifiers: ['ex:bound'] },
    'ex:other': { datatype: 'quantity' },
    'ex:bound': { datatype: 'quantity', units: ['1'] },
    'ex:date': { datatype: 'time' },
  } as unknown as Release['properties'];
  const snak = (content: unknown) => ({ type: 'value', content });
  const quantityStatement = (amount: string, bound = amount) => ({
    value: snak({ amount, unit: '1' }),
    qualifiers: [{ property: 'ex:bound', value: snak({ amount: bound, unit: '1' }) }],
  });
  const quantityClause = {
    facet: 'statement' as const,
    property: 'ex:measure',
    range: { lte: 1, unit: '1' },
    qualifiers: [{ property: 'ex:bound', range: { lte: 1, unit: '1' } }],
  };
  const exact = normalizeSourceStatement('ex:measure', quantityStatement('+1'), properties)!;
  const rounded = normalizeSourceStatement('ex:measure', quantityStatement('1.0000000000000001'), properties)!;
  const bounded = normalizeSourceStatement(
    'ex:measure',
    { value: snak({ amount: '+1', lowerBound: '0.9', upperBound: '+1', unit: '1' }) },
    properties,
  )!;
  const uncertainQualifier = normalizeSourceStatement('ex:measure', quantityStatement('+5', '1.0000000000000001'), properties)!;
  const unrelated = normalizeSourceStatement('ex:other', { value: snak({ amount: '+2', unit: '1' }) }, properties)!;
  const positive = compileCurrentFilter({ statement: { property: 'ex:measure', range: { lte: 1, unit: '1' } } });
  const negative = compileCurrentFilter({ not: { statement: { property: 'ex:measure', range: { lte: 1, unit: '1' } } } });

  expect(exact.facet).toEqual({ kind: 'quantity', amount: 1, unit: '1' });
  expect(holdsCurrentStatements([exact], quantityClause)).toBe(true);
  expect(rounded.facet).toEqual({ kind: 'unsupported', datatype: 'quantity', unit: '1' });
  expect(holdsCurrentStatements([rounded], quantityClause)).toBe('not_proven');
  expect(bounded.facet).toEqual({ kind: 'unsupported', datatype: 'quantity', unit: '1' });
  expect(holdsCurrentStatements([bounded], quantityClause)).toBe('not_proven');
  expect(uncertainQualifier.qualifiers?.[0]?.facet).toEqual({
    kind: 'unsupported',
    datatype: 'quantity',
    unit: '1',
  });
  expect(
    holdsCurrentStatements(
      [uncertainQualifier],
      { ...quantityClause, range: { gte: 5, lte: 5, unit: '1' }, qualifiers: [{ property: 'ex:bound', range: { lte: 1, unit: '1' } }] },
    ),
  ).toBe('not_proven');
  expect(positive.evaluate(['not_proven'])).toBe('not_proven');
  expect(negative.evaluate(['not_proven'])).toBe('not_proven');
  expect(holdsCurrentStatements([unrelated], quantityClause)).toBe(false);

  const time = (before?: number, after?: number, value = '+2024-06-15T00:00:00Z') => ({
    value: snak({
      time: value,
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    }),
  });
  const exactDay = normalizeSourceStatement('ex:date', time(), properties)!;
  const uncertainDay = normalizeSourceStatement('ex:date', time(1, 1), properties)!;
  const dateClause = {
    facet: 'statement' as const,
    property: 'ex:date',
    range: { type: 'time' as const, gte: '2024-06-15', lte: '2024-06-15' },
  };
  expect(exactDay.facet).toEqual({ kind: 'time', year: 2024, month: 6, day: 15 });
  expect(holdsCurrentStatements([exactDay], dateClause)).toBe(true);
  expect(uncertainDay.facet).toEqual({ kind: 'unsupported', datatype: 'time' });
  expect(holdsCurrentStatements([uncertainDay], dateClause)).toBe('not_proven');

  const oneBce = normalizeSourceStatement('ex:date', time(undefined, undefined, '-0001-01-01T00:00:00Z'), properties)!;
  expect(oneBce.value).toBe('-0001-01-01T00:00:00Z');
  expect(oneBce.facet).toEqual({ kind: 'time', year: 0, month: 1, day: 1 });
});
