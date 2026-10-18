import { expect, test } from 'bun:test';
import { languagesAfterRefresh, personPreferenceCommand, type PersonPreferences } from './person-preferences.ts';

const saved: PersonPreferences = { profile: 'person-preferences-v1', profileVisibility: 'public',
  followPolicy: 'everyone', hideReadingActivity: false, spoilerPolicy: 'hide-unread',
  contentLanguages: ['ja', 'en'], version: 7, blockedPeople: ['someone'] };

test('a privacy or spoiler command includes the accepted language order and only writable preferences', () => {
  const languages = ['en', 'ja', 'yue-Hant'];
  const command = personPreferenceCommand(saved, languages, { spoilerPolicy: 'show', profileVisibility: 'private' });
  languages.reverse();
  expect(command).toEqual({ profileVisibility: 'private', followPolicy: 'everyone', hideReadingActivity: false,
    spoilerPolicy: 'show', contentLanguages: ['en', 'ja', 'yue-Hant'], expectedVersion: 7 });
  expect(saved.contentLanguages).toEqual(['ja', 'en']);
});

for (const draft of [['en', 'ja'], ['ja'], ['ja', 'en', 'fr'], []]) {
  test(`conflict recovery preserves accepted language changes: ${JSON.stringify(draft)}`, () => {
    const latest = { ...saved, version: 8, followPolicy: 'nobody' as const, contentLanguages: ['ko'] };
    const recovered = languagesAfterRefresh(saved, draft, latest);
    const retry = personPreferenceCommand(latest, recovered, { spoilerPolicy: 'show' });
    expect(retry.contentLanguages).toEqual(draft);
    expect(retry.followPolicy).toBe('nobody');
    expect(retry.spoilerPolicy).toBe('show');
    expect(retry.expectedVersion).toBe(8);
  });
}

test('a conflict refresh adopts remote languages when the user did not edit them', () => {
  const latest = { ...saved, version: 8, contentLanguages: ['ko', 'fr'] };
  expect(languagesAfterRefresh(saved, ['ja', 'en'], latest)).toEqual(['ko', 'fr']);
});
