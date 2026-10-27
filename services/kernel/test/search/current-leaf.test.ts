import { expect, test } from 'bun:test';
import { holdsCurrentStatements, holdsCurrentType } from '../../src/search/current-leaf.ts';
import type { FactClause } from '../../src/search/disclosure/check.ts';
import type { IndexedStatement } from '../../src/search/source.ts';

type StatementClause = Extract<FactClause, { facet: 'statement' }>;
const values: StatementClause = { facet: 'statement', property: 'schema:code', values: ['ABC', 'DEF'] };
const statement = (overrides: Partial<IndexedStatement> = {}): IndexedStatement => ({
  property: 'schema:code',
  value: 'ABC',
  ...overrides,
});
const time = (year: number): IndexedStatement => statement({ facet: { kind: 'time', year } });
const quantity = (amount: number, unit = 'unit:MIN'): IndexedStatement =>
  statement({ facet: { kind: 'quantity', amount, unit } });
const range = (bounds: { gte?: number; lte?: number; unit?: string }): StatementClause => ({
  facet: 'statement',
  property: 'schema:code',
  range: bounds,
});
const role = { property: 'rezics:role', value: 'role:author' };
const credit = { property: 'rezics:credit', value: 'credit:primary' };
const qualified = {
  ...values,
  qualifiers: [
    { property: role.property, in: ['role:editor', role.value] },
    { property: credit.property, in: [credit.value] },
  ],
} satisfies StatementClause;

test('current type is exact in-values membership, with empty and duplicate choices', () => {
  expect(holdsCurrentType('schema:Book', { facet: 'type', values: ['schema:Recipe', 'schema:Book'] })).toBe(true);
  expect(holdsCurrentType('schema:Book', { facet: 'type', values: ['schema:Book', 'schema:Book'] })).toBe(true);
  for (const type of ['schema:book', ' schema:Book', 'Book', 'schema:Recipe']) {
    expect(holdsCurrentType(type, { facet: 'type', values: ['schema:Book'] })).toBe(false);
  }
  expect(holdsCurrentType('schema:Book', { facet: 'type', values: [] })).toBe(false);
});

test('property and stored value must both match exactly on one statement', () => {
  expect(holdsCurrentStatements([statement()], values)).toBe(true);
  expect(holdsCurrentStatements([statement({ value: 'DEF' })], values)).toBe(true);
  for (const entry of [
    statement({ property: 'schema:Code' }),
    statement({ property: 'code' }),
    statement({ value: 'abc' }),
    statement({ value: ' ABC' }),
    statement({ value: 'alias:ABC' }),
  ]) {
    expect(holdsCurrentStatements([entry], values)).toBe(false);
  }
  expect(holdsCurrentStatements([statement({ property: 'other' }), statement({ value: 'other' })], values)).toBe(false);
});

test('values use the stored string without requiring or interpreting facet metadata', () => {
  for (const entry of [
    statement(),
    statement({ facet: { kind: 'item' } }),
    statement({ facet: { kind: 'code' } }),
    time(2000),
    quantity(45),
    time(NaN),
  ]) {
    expect(holdsCurrentStatements([entry], values)).toBe(true);
  }
  expect(holdsCurrentStatements([statement()], { ...values, values: [] })).toBe(false);
});

test('multiple statements are alternatives and duplicate evidence or values do not change matching', () => {
  const miss = statement({ value: 'other' });
  const match = statement();
  expect(holdsCurrentStatements([], values)).toBe(false);
  expect(holdsCurrentStatements([miss, miss], values)).toBe(false);
  expect(holdsCurrentStatements([miss, match, match], { ...values, values: ['ABC', 'ABC'] })).toBe(true);
  expect(holdsCurrentStatements([match, miss], values)).toBe(true);
});

test('time ranges use inclusive astronomical year boundaries, including year zero and negative years', () => {
  const clause = range({ gte: -1, lte: 1 });
  for (const year of [-1, 0, 1]) expect(holdsCurrentStatements([time(year)], clause)).toBe(true);
  for (const year of [-2, 2]) expect(holdsCurrentStatements([time(year)], clause)).toBe(false);
  expect(holdsCurrentStatements([time(2000)], range({ gte: 2000, lte: 2000 }))).toBe(true);
});

test('quantity ranges use inclusive decimal amounts and exact units without conversion', () => {
  const clause = range({ gte: 0.5, lte: 1.5, unit: 'unit:MIN' });
  for (const amount of [0.5, 1, 1.5]) expect(holdsCurrentStatements([quantity(amount)], clause)).toBe(true);
  for (const amount of [0.49, 1.51]) expect(holdsCurrentStatements([quantity(amount)], clause)).toBe(false);
  for (const unit of ['unit:min', 'MIN', 'unit:HUR', ' unit:MIN']) {
    expect(holdsCurrentStatements([quantity(1, unit)], clause)).toBe(false);
  }
  expect(holdsCurrentStatements([quantity(60, 'unit:SEC')], range({ gte: 1, lte: 1, unit: 'unit:MIN' }))).toBe(false);
});

test('one-sided bounds retain their inclusive boundary for both range datatypes', () => {
  for (const unit of [undefined, 'unit:MIN']) {
    const entry = unit === undefined ? time : quantity;
    const units = unit === undefined ? {} : { unit };
    expect(holdsCurrentStatements([entry(10)], range({ gte: 10, ...units }))).toBe(true);
    expect(holdsCurrentStatements([entry(11)], range({ gte: 10, ...units }))).toBe(true);
    expect(holdsCurrentStatements([entry(9)], range({ gte: 10, ...units }))).toBe(false);
    expect(holdsCurrentStatements([entry(10)], range({ lte: 10, ...units }))).toBe(true);
    expect(holdsCurrentStatements([entry(9)], range({ lte: 10, ...units }))).toBe(true);
    expect(holdsCurrentStatements([entry(11)], range({ lte: 10, ...units }))).toBe(false);
  }
});

test('range datatype follows unit presence; missing, item and code facets cannot satisfy ranges', () => {
  for (const entry of [statement(), statement({ facet: { kind: 'item' } }), statement({ facet: { kind: 'code' } })]) {
    expect(holdsCurrentStatements([entry], range({ gte: 0 }))).toBe(false);
    expect(holdsCurrentStatements([entry], range({ gte: 0, unit: 'unit:MIN' }))).toBe(false);
  }
  expect(holdsCurrentStatements([quantity(10)], range({ gte: 0 }))).toBe(false);
  expect(holdsCurrentStatements([time(10)], range({ gte: 0, unit: 'unit:MIN' }))).toBe(false);
  expect(holdsCurrentStatements([quantity(10, '')], range({ gte: 0, unit: '' }))).toBe(true);
  expect(holdsCurrentStatements([time(10)], range({ gte: 0, unit: '' }))).toBe(false);
  expect(holdsCurrentStatements([time(10)], { ...range({ gte: 0 }), property: 'other' })).toBe(false);
});

test('non-finite time and quantity values never satisfy ranges, even when comparisons would pass', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    expect(holdsCurrentStatements([time(value)], range({ gte: 0 }))).toBe(false);
    expect(holdsCurrentStatements([time(value)], range({ lte: 0 }))).toBe(false);
    expect(holdsCurrentStatements([quantity(value)], range({ gte: 0, unit: 'unit:MIN' }))).toBe(false);
    expect(holdsCurrentStatements([quantity(value)], range({ lte: 0, unit: 'unit:MIN' }))).toBe(false);
  }
});

test('qualifier clauses are ALL required, each accepting any of its exact in-values', () => {
  expect(holdsCurrentStatements([statement({ qualifiers: [role, credit] })], qualified)).toBe(true);
  expect(
    holdsCurrentStatements([statement({ qualifiers: [{ ...role, value: 'role:editor' }, credit] })], qualified),
  ).toBe(true);
  for (const qualifiers of [
    undefined,
    [],
    [role],
    [credit],
    [{ ...role, property: 'role' }, credit],
    [{ ...role, value: 'ROLE:AUTHOR' }, credit],
  ]) {
    expect(holdsCurrentStatements([statement(qualifiers === undefined ? {} : { qualifiers })], qualified)).toBe(false);
  }
  expect(
    holdsCurrentStatements([statement({ qualifiers: [role] })], {
      ...values,
      qualifiers: [{ property: role.property, in: [] }],
    }),
  ).toBe(false);
});

test('qualifiers cannot be pooled across statements or borrowed from a nonmatching statement', () => {
  expect(
    holdsCurrentStatements([statement({ qualifiers: [role] }), statement({ qualifiers: [credit] })], qualified),
  ).toBe(false);
  expect(
    holdsCurrentStatements([statement(), statement({ value: 'other', qualifiers: [role, credit] })], qualified),
  ).toBe(false);
  expect(
    holdsCurrentStatements([statement(), statement({ property: 'other', qualifiers: [role, credit] })], qualified),
  ).toBe(false);
  expect(
    holdsCurrentStatements([statement({ qualifiers: [role] }), statement({ qualifiers: [role, credit] })], qualified),
  ).toBe(true);
});

test('range and qualifiers must hold on the same statement too', () => {
  const clause: StatementClause = {
    ...range({ gte: 30, lte: 60, unit: 'unit:MIN' }),
    qualifiers: qualified.qualifiers,
  };
  const both = { ...quantity(30), qualifiers: [role, credit] };
  expect(holdsCurrentStatements([both], clause)).toBe(true);
  expect(
    holdsCurrentStatements(
      [quantity(30), { ...both, facet: { kind: 'quantity', amount: 61, unit: 'unit:MIN' } }],
      clause,
    ),
  ).toBe(false);
  expect(
    holdsCurrentStatements(
      [
        { ...both, qualifiers: [role] },
        { ...both, qualifiers: [credit] },
      ],
      clause,
    ),
  ).toBe(false);
});

test('empty qualifier lists impose no restriction; duplicate clauses and qualifiers are idempotent', () => {
  expect(holdsCurrentStatements([statement()], { ...values, qualifiers: [] })).toBe(true);
  expect(
    holdsCurrentStatements([statement({ qualifiers: [role, role, credit, credit] })], {
      ...qualified,
      qualifiers: [...qualified.qualifiers!, ...qualified.qualifiers!],
    }),
  ).toBe(true);
});

test('matching leaves never mutate frozen types, clauses, statement arrays or nested evidence', () => {
  const types = Object.freeze(['schema:Book', 'schema:Book']);
  const typeClause = Object.freeze({ facet: 'type' as const, values: types });
  const entries = [
    statement({ facet: { kind: 'quantity', amount: 45, unit: 'unit:MIN' }, qualifiers: [role, credit] }),
  ];
  const clause: StatementClause = {
    ...range({ gte: 30, lte: 60, unit: 'unit:MIN' }),
    qualifiers: structuredClone(qualified.qualifiers),
  };
  function freeze(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  const before = structuredClone({ entries, clause });
  freeze(entries);
  freeze(clause);
  expect(holdsCurrentType('schema:Book', typeClause)).toBe(true);
  expect(holdsCurrentStatements(entries, clause)).toBe(true);
  expect(holdsCurrentStatements(entries, { ...clause, property: 'other' })).toBe(false);
  expect({ entries, clause }).toEqual(before);
  expect(types).toEqual(['schema:Book', 'schema:Book']);
});

test('a false match describes only the selected evidence window, not native absence or Access', () => {
  // No native identity, source membership, completeness proof, or Boolean evaluation lives here.
  // On a PARTIAL window the caller needs the owner's current complete-absence proof;
  // without it, this false maps to not_proven in the one Boolean planner, even under NOT.
  const partial: readonly IndexedStatement[] = [statement({ value: 'other' })];
  expect(holdsCurrentStatements(partial, values)).toBe(false);
  expect(holdsCurrentStatements([...partial, statement()], values)).toBe(true);
});
