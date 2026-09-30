import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { resourceSummaryBatch } from '../src/modules/media/summary-contract.ts';

const reference = 'https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = { profile: 'resource-summary-batch-v1', complete: true,
  generation: { graph: 'epoch:7', media: null },
  cost: { graphQueries: 1, mediaQueries: 0, accessChecks: 0, accessQueries: 0 } };
const fallback = { reference, status: 'available', type: 'work', disclosure: 'public',
  base: 'work', work: reference,
  name: { value: 'A work', language: 'en', direction: 'ltr', basis: 'requested' },
  avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'admitted-default', resourceType: 'work' } };

test('VIEW07/VIEW08: summary schema rejects hidden fields and malformed media in partial batches', () => {
  const unavailable = { reference, status: 'unavailable' };
  expect(Value.Check(resourceSummaryBatch, { ...base, summaries: [fallback, unavailable] })).toBe(true);
  expect(Value.Check(resourceSummaryBatch, { ...base, summaries: [{ ...unavailable,
    avatar: { kind: 'image', selection: 'private-selection' } }] })).toBe(false);
  expect(Value.Check(resourceSummaryBatch, { ...base, summaries: [{ ...fallback,
    avatar: { kind: 'image', selection: 'private-selection', url: '/v1/media/avatars/private-selection',
      mediaType: 'image/png', width: 0, height: 256, crop: null,
      basis: { policy: 'avatar-selection-v1', context: 'private' } } }] })).toBe(false);
  expect(Value.Check(resourceSummaryBatch, { ...base, summaries: [] })).toBe(false);
  expect(Value.Check(resourceSummaryBatch, { ...base, summaries: [fallback],
    cost: { ...base.cost, mediaQueries: 2 } })).toBe(false);
});
