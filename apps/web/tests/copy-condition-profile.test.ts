import { expect, test } from 'bun:test';
import type { Release } from '../src/subject/definitions';
import { resolveCopyProfile } from '../src/library/copies-profiles';

test('condition preparation preserves explicit kind admission and absence without guessing from labels', () => {
  const release: Release = {
    types: { book: { library: { profileId: 'copies' } } },
    properties: {},
    libraryProfiles: {
      copies: { id: 'copies', copies: { kinds: [
        { id: 'disc', labels: { en: 'Disc' }, condition: 'physical-v1', statuses: [] },
        { id: 'physical', labels: { en: 'Physical' }, statuses: [] },
        { id: 'digital', labels: { en: 'Digital' }, statuses: [] },
      ] } },
    },
  };
  const kinds = resolveCopyProfile(release, 'book', 'en').kinds;
  expect(kinds[0]?.condition).toBe('physical-v1');
  expect(kinds[1]).not.toHaveProperty('condition');
  expect(kinds[2]).not.toHaveProperty('condition');
  expect(resolveCopyProfile(release, 'missing', 'en').kinds).toEqual([]);
});
