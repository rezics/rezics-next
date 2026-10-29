import { describe, expect, test } from 'bun:test';
import { libraryChoices, libraryCopyKindLabel, libraryCopyStatusLabel } from '../src/library/profiles';
import type { Release } from '../src/subject/definitions';

const release = {
  types: { 'schema:Book': { library: { profileId: 'book-profile' } } },
  libraryProfiles: {
    'book-profile': {
      copies: {
        kinds: [
          { id: 'print', labels: { en: 'Print' }, statuses: [{ id: 'shelf', labels: { en: 'On shelf' } }, { id: 'loan', labels: { en: 'On loan' }] },
          { id: 'digital', labels: { en: 'Digital' }, statuses: [{ id: 'available', labels: { en: 'Available' } }] },
        ],
      },
    },
    'legacy-fixed-v1': { copies: { kinds: [{ id: 'legacy', labels: { en: 'Legacy' }, statuses: [{ id: 'owned', labels: { en: 'Owned' } }] }] } },
  },
} as unknown as Release;

describe('profile copy declarations', () => {
  test('keeps kind and status choices in declared order and scopes statuses to each kind', () => {
    expect(libraryChoices(release, 'schema:Book')?.copyKinds).toEqual([
      { id: 'print', statuses: ['shelf', 'loan'] },
      { id: 'digital', statuses: ['available'] },
    ]);
    expect(libraryCopyStatusLabel(release, 'schema:Book', 'digital', 'loan', 'en')).toBeUndefined();
  });

  test('names current and legacy kinds, while unknown IDs remain unnamed for neutral fallback', () => {
    expect(libraryCopyKindLabel(release, 'schema:Book', 'print', 'en')?.text).toBe('Print');
    expect(libraryCopyStatusLabel(release, 'schema:Book', 'legacy', 'owned', 'en')?.text).toBe('Owned');
    expect(libraryCopyStatusLabel(release, 'schema:Book', 'print', 'unknown', 'en')).toBeUndefined();
  });
});
