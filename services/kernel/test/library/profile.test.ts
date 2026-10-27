import { expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { releaseDigest } from '@rezics/definitions';
import { fixture, libraryProfile } from '../../../../packages/definitions/test/support/library-profiles.ts';
import {
  hasCopyStatus,
  hasEntryState,
  progressUnit,
  resolveLibraryProfilePin,
  selectLibraryProfile,
} from '../../src/library/profile.ts';

test('profile selection uses the actual compiled reference and stored pins never current ancestry or a default legacy capability', async () => {
  const parent = libraryProfile('fixture.parent', 'page');
  const child = libraryProfile('fixture.child', 'track');
  child.entryStateSet = { id: 'player-choice', states: [{ id: 'playing', role: 'active' }] };
  child.copies = { kinds: [{ id: 'record', statuses: [{ id: 'kept' }] }] };
  const release = await compileCatalogue(fixture(parent, child));
  const digest = releaseDigest(release);
  const profile = selectLibraryProfile(release, 'ex:Child');
  expect(profile).not.toBeNull();
  expect(profile!.id).toBe('fixture.child');
  expect(hasEntryState(profile!, 'playing')).toBe(true);
  expect(hasEntryState(profile!, 'planned')).toBe(false);
  expect(hasCopyStatus(profile!, 'record', 'kept')).toBe(true);
  expect(hasCopyStatus(profile!, 'physical', 'owned')).toBe(false);
  expect(progressUnit(profile!, 'scalar_amount', 'track')?.id).toBe('track');
  expect(progressUnit(profile!, 'cursor_position', 'track')).toBeNull();
  expect(progressUnit(profile!, 'scalar_amount', 'page')).toBeNull();
  expect(selectLibraryProfile(release, 'ex:Person')).toBeNull();
  expect(selectLibraryProfile(release, 'ex:Missing')).toBeNull();
  const pin = {
    provenance: 'profile' as const,
    releaseDigest: digest,
    acceptingType: 'ex:Child',
    profileId: 'fixture.child',
  };
  expect(resolveLibraryProfilePin({ digest, release }, pin)).toEqual(profile);
  expect(resolveLibraryProfilePin({ digest, release }, { ...pin, profileId: 'fixture.parent' })).toBeNull();
  expect(resolveLibraryProfilePin({ digest: 'sha256:' + '0'.repeat(64), release }, pin)).toBeNull();
  expect(resolveLibraryProfilePin({ digest, release }, { ...pin, acceptingType: 'ex:Person' })).toBeNull();
  const old = {
    provenance: 'legacy' as const,
    releaseDigest: digest,
    acceptingType: null,
    profileId: 'legacy-fixed-v1' as const,
  };
  expect(resolveLibraryProfilePin({ digest, release }, old)?.id).toBe('legacy-fixed-v1');
  expect(resolveLibraryProfilePin({ digest, release }, { ...old, acceptingType: 'hidden:historical:type' })?.id).toBe(
    'legacy-fixed-v1',
  );
  expect(selectLibraryProfile(release, 'ex:Person')).toBeNull();
});
