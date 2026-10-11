import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { resourceSummaryBatch } from '../src/modules/media/summary-contract.ts';
import { coverCreditFromProvenance, coverCreditSchema } from '../src/modules/media/cover-credit.ts';

const reference = 'https://rezics.com/id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = { profile: 'resource-summary-batch-v1', complete: true,
  generation: { graph: 'epoch:7', media: null },
  cost: { graphQueries: 1, mediaQueries: 0, accessChecks: 0, accessQueries: 0 } };
const fallback = { reference, status: 'available', type: 'work', disclosure: 'public',
  base: 'work', work: reference,
  address: { prefix: '/w/',key: 'a-work',suffixSource: 'A work' },
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
      coverCredit: null,
      basis: { policy: 'avatar-selection-v1', context: 'private' } } }] })).toBe(false);
  const imageAvatar = { kind: 'image', selection: 'public-selection', url: '/v1/media/avatars/public-selection',
    mediaType: 'image/png', width: 320, height: 180, crop: null, coverCredit: null,
    basis: { policy: 'avatar-selection-v1', context: 'public' } };
  expect(Value.Check(resourceSummaryBatch, { ...base, summaries: [{ ...fallback, avatar: imageAvatar }] })).toBe(true);
  const { coverCredit: _coverCredit, ...withoutCoverCredit } = imageAvatar;
  expect(Value.Check(resourceSummaryBatch, { ...base, summaries: [{ ...fallback, avatar: withoutCoverCredit }] })).toBe(false);
  expect(Value.Check(resourceSummaryBatch, { ...base, summaries: [] })).toBe(false);
  expect(Value.Check(resourceSummaryBatch, { ...base, summaries: [fallback],
    cost: { ...base.cost, mediaQueries: 2 } })).toBe(false);
});

test('SOURCE-COVER-READ: copyright mark comes only from revision source and holder evidence', () => {
  const source = { displayName: 'Bangumi', href: 'https://bgm.tv/subject/1' };
  expect(coverCreditFromProvenance({ source, holderEvidence: null })).toEqual({
    kind: 'copyright',
    text: '(c) rights holder via Bangumi',
    holder: null,
    source: { name: 'Bangumi', href: source.href },
    permittedRole: 'cover',
  });
  expect(coverCreditFromProvenance({ source, holderEvidence: { name: 'Evidence Holder' } })).toMatchObject({
    text: 'Evidence Holder', holder: 'Evidence Holder',
  });
  expect(coverCreditFromProvenance({ source: { displayName: 'Bangumi' }, holderEvidence: null })).toBeNull();
  expect(Value.Check(coverCreditSchema, null)).toBe(true);
  expect(Value.Check(coverCreditSchema, { kind: 'copyright', text: 'A holder', holder: 'A holder',
    source: { name: 'Bangumi', href: source.href }, permittedRole: 'cover' })).toBe(true);
  expect(Value.Check(coverCreditSchema, { kind: 'copyright', text: '', holder: null,
    source: { name: 'Bangumi', href: source.href }, permittedRole: 'cover' })).toBe(false);
});
