import { expect, test } from 'bun:test';
import { checkFirstPartyBundle, InvalidFirstPartyBundle }
  from '../src/modules/theme/first-party-bundle.ts';

const bundle = {
  profile: 'first-party-bundle-v1',
  hostZone: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  entry: 'assets/main.js',
  files: [
    { path: 'assets/main.js', digest: 'a'.repeat(64), gzipBytes: 24000 },
    { path: 'assets/main.css', digest: 'b'.repeat(64), gzipBytes: 12000 },
  ],
  slots: ['hero', 'module:shelf'],
  connectOrigins: [], imageOrigins: ['https://media.rezics.com'], fontOrigins: [],
};

test('first-party-bundle-v1 pins exact files, host, slots and origins', () => {
  const first = checkFirstPartyBundle(bundle);
  const reordered = checkFirstPartyBundle({ ...bundle, files: [...bundle.files].reverse(),
    slots: [...bundle.slots].reverse() });
  expect(first.dependencyDigest).toBe(reordered.dependencyDigest);
  expect(first).toMatchObject({ cssBytes: 12000, jsBytes: 24000, fontBytes: 0 });
  expect(checkFirstPartyBundle({ ...bundle,
    hostZone: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002' }).dependencyDigest)
    .not.toBe(first.dependencyDigest);
});

test('first-party-bundle-v1 rejects missing bytes, path traversal and over-budget code', () => {
  expect(() => checkFirstPartyBundle({ ...bundle, entry: 'assets/missing.js' }))
    .toThrow(InvalidFirstPartyBundle);
  expect(() => checkFirstPartyBundle({ ...bundle, files: [{ ...bundle.files[0],
    path: 'assets/../main.js' }] })).toThrow(InvalidFirstPartyBundle);
  expect(() => checkFirstPartyBundle({ ...bundle, files: [{ ...bundle.files[0], gzipBytes: 50001 }] }))
    .toThrow(InvalidFirstPartyBundle);
  expect(() => checkFirstPartyBundle({ ...bundle, imageOrigins: ['https://media.rezics.com/'] }))
    .toThrow(InvalidFirstPartyBundle);
});
