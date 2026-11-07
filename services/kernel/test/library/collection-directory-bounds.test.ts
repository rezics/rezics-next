import { expect, test } from 'bun:test';
import { collectionDirectoryPagePlan } from '../../src/library/collection-directory-bounds.ts';

const input = {
  route: 1,
  curator_account_id: '00000000-0000-7000-8000-000000000001',
  after_updated_at: '1970-01-01T00:00:00.000000Z',
  after_id: '00000000-0000-7000-8000-000000000002',
  has_cursor: false,
  limit: 20,
};

test('directory page plans bind curator rows or the public-floor parameter map', () => {
  const curator = collectionDirectoryPagePlan(input, { status: 'ready', source: 'curator', parameters: {} });
  const published = collectionDirectoryPagePlan(input, {
    status: 'ready',
    source: 'public',
    parameters: { policy_visibility: 'public' },
  });
  expect(curator.total.candidateKeys).toBe(40);
  expect(published.total.candidateKeys).toBe(40);
  expect(curator.total.engineRequests).toBe(0);
  expect(published.total.engineRequests).toBe(0);
  expect(published.total.bytes).toBeGreaterThan(curator.total.bytes);
});
