import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaImage } from '@rezics/ui/media-image';
import { anonymousMediaViewer, mediaViewer, readMediaViewer } from '../features/api/media-viewer.ts';

test('a signed-in viewer becomes ready, renders ordinary images, and masks NSFW by default', async () => {
  const preferences = { age: 'unknown', accountEligible: true, adultAvailable: true,
    categories: { general: true, r15: false, r18: false, r18g: false }, nsfwDisplay: 'mask' };
  const fetcher = (async (url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer reader-token');
    expect(headers.has('cookie')).toBe(false);
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('manual');
    // The full settings route requires an Account session; the reader owns only an OAuth token.
    return new URL(String(url)).pathname === '/api/account/content-preferences/viewer'
      ? Response.json(preferences) : new Response(null, { status: 401 });
  }) as typeof fetch;
  const viewer = await readMediaViewer({ accountOrigin: 'http://account.local', accessToken: 'reader-token', fetch: fetcher });
  expect(viewer).toMatchObject({ ready: true, signedIn: true, nsfwDisplay: 'mask' });
  const render = (nsfw: 'sfw' | 'nsfw', conceal = false) => renderToStaticMarkup(createElement(MediaImage, {
    viewer, conceal, alt: 'Cover', metadata: { representationId: 'cover', src: 'https://media.example/cover.png',
      nsfw, ageRating: { status: 'unassessed' } },
  }));
  expect(render('sfw')).toContain('data-slot="media-image"');
  expect(render('sfw')).toContain('src="https://media.example/cover.png"');
  expect(render('nsfw')).toContain('data-slot="media-image-mask"');
  expect(render('nsfw')).not.toContain('<img');
  expect(render('sfw', true)).toContain('data-slot="media-image-mask"');
});

test('denied or malformed Account viewer reads keep signed-in images unavailable', async () => {
  for (const response of [new Response(null, { status: 401 }), new Response(null, { status: 503 }),
    Response.json({ age: 'adult' }), Response.json(null)]) {
    expect(await readMediaViewer({ accountOrigin: 'http://account.local', accessToken: 'token',
      fetch: (async () => response) as unknown as typeof fetch })).toMatchObject({ ready: false, signedIn: true });
  }
});

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
