import { expect, test } from 'bun:test';
import { InvalidAddressClaim, workAddressDigest } from '../../../services/main/src/modules/address/claim.ts';
import { workAddressRenameDigest } from '../../../services/main/src/modules/address/rename.ts';
import { ID } from '../../../services/main/src/modules/work/activate.ts';

const work = `${ID}0190a5b2-7c3e-7abc-8def-0123456789ab`;
const actor = `${ID}0190a5b2-7c3e-7abc-8def-0123456789ac`;
const revision = `${ID}0190a5b2-7c3e-7abc-8def-0123456789ad`;

test('VIEW01: claims normalize ASCII case and share one digest per normalized slug', () => {
  expect(workAddressDigest({ work, slug: 'Tide-Maps', actingSubject: actor }))
    .toBe(workAddressDigest({ work, slug: 'tide-maps', actingSubject: actor }));
  for (const slug of ['', 'a--b', '-lead', 'trail-', 'has space', 'x'.repeat(65), 'ünïcode']) {
    expect(() => workAddressDigest({ work, slug, actingSubject: actor })).toThrow(InvalidAddressClaim);
  }
});

test('VIEW01: a UUID-shaped slug is never assigned, since /w/{uuid} always names a Work ID', () => {
  for (const slug of ['0190a5b2-7c3e-7abc-8def-0123456789ab', '0190A5B2-7C3E-7ABC-8DEF-0123456789AB']) {
    expect(() => workAddressDigest({ work, slug, actingSubject: actor })).toThrow('reserved work slug');
    expect(() => workAddressRenameDigest({ work, slug: 'tide-maps', newSlug: slug, expectedRevision: revision,
      actingSubject: actor })).toThrow('reserved work slug');
  }
  // Near misses stay ordinary slugs.
  expect(workAddressDigest({ work, slug: '0190a5b2-7c3e-7abc-8def-0123456789a', actingSubject: actor }))
    .toMatch(/^[0-9a-f]{64}$/);
});
