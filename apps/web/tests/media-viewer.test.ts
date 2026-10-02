import { expect, test } from 'bun:test';
import { anonymousMediaViewer, mediaViewer, readMediaViewer } from '../features/api/media-viewer.ts';

test('media display defaults do not grant age-category eligibility', () => {
  const preferences = { age: 'adult', accountEligible: true, adultAvailable: false,
    categories: { general: false, r15: true, r18: true, r18g: true }, nsfwDisplay: 'show' };
  expect(mediaViewer(preferences)).toMatchObject({ nsfwDisplay: 'show',
    optIns: { general: false, r15: true, sexual: false, grotesque: false } });
  expect(mediaViewer({ ...preferences, accountEligible: false })?.optIns.r15).toBe(false);
  expect(mediaViewer({ ...preferences, nsfwDisplay: undefined })?.nsfwDisplay).toBe('mask');
  expect(mediaViewer({ ...preferences, nsfwDisplay: 'invalid' })).toBeNull();
});

test('media viewer reads preserve unavailable state and never expose private Account fields', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error('offline'); }) as unknown as typeof fetch;
  expect(await readMediaViewer({ accountOrigin: 'http://account.local', fetch: fetcher })).toBe(anonymousMediaViewer);
  expect(calls).toBe(0);
  expect(await readMediaViewer({ accountOrigin: 'http://account.local', accessToken: 'token', fetch: fetcher }))
    .toMatchObject({ signedIn: true, ready: false, nsfwDisplay: 'mask' });
  const viewer = mediaViewer({ age: 'adult', accountEligible: true, adultAvailable: true,
    categories: { general: true, r15: true, r18: false, r18g: true }, birthDate: '1980-01-01', country: 'US' });
  expect(viewer).not.toHaveProperty('birthDate');
  expect(viewer).not.toHaveProperty('country');
});
