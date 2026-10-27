import { expect, test } from 'bun:test';
import type { StoredLibraryProfilePin } from './library-profiles-driver.ts';

const profilePin = {
  provenance: 'profile',
  releaseDigest: `sha256:${'a'.repeat(64)}`,
  acceptingType: 'schema:Book',
  profileId: 'book.reading',
} satisfies StoredLibraryProfilePin;

const legacyUnknownTypePin = {
  provenance: 'legacy',
  releaseDigest: `sha256:${'b'.repeat(64)}`,
  acceptingType: null,
  profileId: 'legacy-fixed-v1',
} satisfies StoredLibraryProfilePin;

test('pin fixtures use the agreed release-addressed discriminated union without numeric profile revisions', () => {
  expect(Object.keys(profilePin).sort()).toEqual(['acceptingType', 'profileId', 'provenance', 'releaseDigest']);
  expect(profilePin).toMatchObject({
    provenance: 'profile',
    releaseDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    acceptingType: 'schema:Book',
    profileId: 'book.reading',
  });
  expect(Object.keys(legacyUnknownTypePin).sort()).toEqual([
    'acceptingType',
    'profileId',
    'provenance',
    'releaseDigest',
  ]);
  expect(legacyUnknownTypePin).toMatchObject({
    provenance: 'legacy',
    releaseDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    acceptingType: null,
    profileId: 'legacy-fixed-v1',
  });
  expect(profilePin).not.toHaveProperty('profileRevision');
  expect(legacyUnknownTypePin).not.toHaveProperty('profileRevision');
});

test('legacy pin fixture permits a null accepting type only on the explicit legacy provenance', () => {
  expect(legacyUnknownTypePin.acceptingType).toBeNull();
  expect(legacyUnknownTypePin.profileId).toBe('legacy-fixed-v1');
  expect(profilePin.acceptingType).toBe('schema:Book');
  expect(profilePin.provenance).toBe('profile');
});

test('legacy entry states progress pair matrix copy statuses and sparse IDs stay unchanged', () => {
  const entryStates = ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
  const modes = ['scalar_amount', 'cursor_position', 'completed_units'];
  const units = ['page', 'chapter', 'episode', 'volume', 'minute', 'percent'];
  const progressPairs = modes.flatMap((mode) => units.map((unit) => `${mode}/${unit}`));
  const copyStatuses = ['ordered', 'owned', 'lent', 'disposed'];
  const sparseCompletedUnits = ['1', '3', '7'];

  expect(entryStates).toEqual(['planned', 'in_progress', 'completed', 'paused', 'dropped']);
  expect(progressPairs).toHaveLength(18);
  expect(progressPairs).toContain('scalar_amount/percent');
  expect(progressPairs).toContain('cursor_position/percent');
  expect(progressPairs).toContain('completed_units/percent');
  expect(copyStatuses).toEqual(['ordered', 'owned', 'lent', 'disposed']);
  expect(sparseCompletedUnits).toEqual(['1', '3', '7']);
  expect(sparseCompletedUnits).not.toEqual(['1', '2', '3', '4', '5', '6', '7']);
});
