import { expect, test } from 'bun:test';
import { parseContentPreferences } from '../features/api/content-preferences.ts';

const preference = { revision: 0, birthDate: null, country: null, birthdayPublic: false,
  publicId: null, age: 'unknown', accountEligible: true, adultAvailable: false,
  nsfwDisplay: 'mask', categories: { general: true, r15: false, r18: false, r18g: false } };

test('NSFW display is explicit and independent of age-category opt-ins', () => {
  expect(parseContentPreferences(preference)?.nsfwDisplay).toBe('mask');
  expect(parseContentPreferences({ ...preference, nsfwDisplay: 'show' }))
    .toMatchObject({ nsfwDisplay: 'show', age: 'unknown', categories: preference.categories });
  for (const nsfwDisplay of [undefined, null, true, 'allow'])
    expect(parseContentPreferences({ ...preference, nsfwDisplay })).toBeNull();
});
