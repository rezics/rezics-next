import { expect, test } from 'bun:test';
import {
  admitDiscoveryFilter,
  admitFilter,
  FILTER_LIMITS,
  parseDiscoveryFilter,
  parseFilter,
  positiveDiscoveryFilter,
  validateDiscoveryFilter,
  walkDiscoveryFilter,
  type FilterRelease,
} from '../src/index.ts';

const kinds = new Set(['account', 'schema:Person']);
const person = { type: { in: ['schema:Person'] } };
const account = { kind: { in: ['account'] } };
const release: FilterRelease = {
  types: { 'schema:Person': { bases: [], facets: [] } },
  properties: {},
  filters: {
    'people/all': { filter: person },
    'people/mixed': { filter: account },
    'people/many': { filter: { and: Array.from({ length: FILTER_LIMITS.leaves }, () => person) } },
  },
};

test('kind is a closed opt-in leaf and legacy catalogue parsing/admission stays closed', () => {
  const raw = { or: [account, { not: person }] };
  const parsed = parseDiscoveryFilter(raw);
  expect(parsed).toEqual(raw);
  expect(parseDiscoveryFilter(JSON.parse(JSON.stringify(parsed)))).toEqual(raw);
  expect(() => parseFilter(raw)).toThrow();
  expect(() => admitFilter(parseFilter({ saved: 'people/mixed' }), release)).toThrow();
  for (const invalid of [
    { kind: {} },
    { kind: { in: [] } },
    { kind: { in: ['account'], property: 'kind' } },
    { kind: { in: ['account'], owner: 'accounts' } },
  ])
    expect(() => parseDiscoveryFilter(invalid)).toThrow();
  expect(validateDiscoveryFilter({ type: { in: ['account'] } }, release, kinds)).not.toEqual([]);
  expect(validateDiscoveryFilter({ kind: { in: ['unregistered'] } }, release, kinds)).toEqual([
    { problem: 'unsupported_query', pointer: '/kind/in/0', code: 'unsupported' },
  ]);
});

test('discovery saved expansion retains catalogue domains and charges the complete expanded tree', () => {
  expect(
    admitDiscoveryFilter(parseDiscoveryFilter({ and: [account, { saved: 'people/all' }] }), release, kinds),
  ).toEqual({ and: [account, person] });
  expect(() => admitDiscoveryFilter(parseDiscoveryFilter({ saved: 'people/mixed' }), release, kinds)).toThrow();
  expect(() =>
    admitDiscoveryFilter(parseDiscoveryFilter({ and: [account, { saved: 'people/many' }] }), release, kinds),
  ).toThrow();
  expect(() =>
    parseDiscoveryFilter({ and: Array.from({ length: FILTER_LIMITS.leaves + 1 }, () => account) }),
  ).toThrow();
  expect(() =>
    parseDiscoveryFilter({ kind: { in: Array.from({ length: FILTER_LIMITS.in + 1 }, () => 'account') } }),
  ).toThrow();
});

test('discovery visitors include negated kind leaves without enabling negative-only anchors', () => {
  const negative = parseDiscoveryFilter({ not: account });
  expect([...walkDiscoveryFilter(negative)]).toEqual([negative, account]);
  expect(positiveDiscoveryFilter(negative)).toBe(false);
  expect(positiveDiscoveryFilter(parseDiscoveryFilter({ or: [account, negative] }))).toBe(false);
  expect(positiveDiscoveryFilter(parseDiscoveryFilter({ and: [account, negative] }))).toBe(true);
});
