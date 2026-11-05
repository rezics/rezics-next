import { expect, test } from 'bun:test';
import {
  FacetContinuationLedger,
  MAX_CACHED_FACET_PROPERTIES,
  MAX_FACET_CONTINUATIONS,
} from '../src/search/refinement/facet-continuation';

test('facet cursor progress stays bounded and is released when a property leaves the shown window', () => {
  const shown = Array.from({ length: MAX_CACHED_FACET_PROPERTIES }, (_, index) => `schema:p${index}`);
  const ledger = new FacetContinuationLedger('query');
  ledger.retain([...shown, 'schema:evicted']);
  for (let index = 0; index < MAX_FACET_CONTINUATIONS; index++) ledger.consume('schema:p0', `cursor-${index}`);
  ledger.consume('schema:p0', 'cursor-overflow');
  ledger.consume('schema:evicted', 'cursor-evicted');

  expect(ledger.exhausted('schema:p0')).toBe(true);
  expect(ledger.has('schema:p0', 'cursor-overflow')).toBe(false);
  expect(ledger.has('schema:evicted', 'cursor-evicted')).toBe(false);

  ledger.retain([...shown.slice(1), 'schema:new']);
  expect(ledger.exhausted('schema:p0')).toBe(false);
  expect(ledger.has('schema:p0', 'cursor-0')).toBe(false);
});
