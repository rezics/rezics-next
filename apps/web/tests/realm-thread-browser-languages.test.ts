import { expect, test } from 'bun:test';
import { contentLanguageCookie, displayLanguageHeaders } from '../i18n/display-languages.ts';
import { forwardToMain } from '../features/api/bff.ts';

const segments = ['v1', 'realms', '00000000-0000-4000-a000-000000000001',
  'threads', '00000000-0000-4000-a000-000000000002'];

test('anonymous thread continuation keeps the server reading basis without sending cookies or identity', async () => {
  const pageUrl = 'https://web.test/en';
  const initialHeaders = displayLanguageHeaders({ signedIn: false,
    cookie: contentLanguageCookie(['ja']), pageUrl, browser: 'en-US,en;q=0.9' });
  const basis = initialHeaders['x-rezics-display-languages']!;
  expect(basis).toBe('ja,en,en-US');
  let upstreamHeaders = new Headers();
  const response = await forwardToMain(new Request(`https://web.test/api/main/${segments.join('/')}?cursor=page`, {
    headers: { ...initialHeaders, 'x-rezics-page-url': pageUrl, 'accept-language': 'en-US,en;q=0.9' },
    credentials: 'omit',
  }), segments, { mainOrigin: 'https://main.test', accessToken: undefined,
    fetch: (async (_input, init) => {
      upstreamHeaders = new Headers(init?.headers);
      return Response.json(upstreamHeaders.get('x-rezics-display-languages') === basis
        ? { profile: 'realm-thread-v1', continuations: [] } : { error: 'read_basis_changed' },
      { status: upstreamHeaders.get('x-rezics-display-languages') === basis ? 200 : 409 });
    }) as typeof fetch });
  expect(upstreamHeaders.has('authorization')).toBe(false);
  expect(upstreamHeaders.has('cookie')).toBe(false);
  expect(response.status).toBe(200);
  expect(upstreamHeaders.get('x-rezics-display-languages')).toBe(basis);
});

test('a browser language basis cannot replace ordinary reads or invalid continuation metadata', async () => {
  for (const input of [
    { cursor: true, basis: 'ja', path: ['v1', 'works', segments[2]!] },
    { cursor: false, basis: 'ja' },
    { cursor: true, basis: 'not_a_language' },
    { cursor: true, basis: 'ja,ja' },
    { cursor: true, basis: Array.from({ length: 21 }, (_, n) => `en-x-${n}`).join(',') },
  ]) {
    let upstreamHeaders = new Headers();
    const path = input.path ?? segments;
    await forwardToMain(new Request(`https://web.test/api/main/${path.join('/')}${input.cursor ? '?cursor=page' : ''}`, {
      headers: { 'x-rezics-display-languages': input.basis,
        'x-rezics-page-url': 'https://web.test/en', 'accept-language': 'en' },
    }), path, { mainOrigin: 'https://main.test', accessToken: undefined,
      fetch: (async (_input, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return Response.json({});
      }) as typeof fetch });
    expect(upstreamHeaders.get('x-rezics-display-languages')).toBe('en');
  }
});

test('an explicitly empty anonymous cursor basis does not gain browser fallbacks', async () => {
  let upstreamHeaders = new Headers();
  await forwardToMain(new Request(`https://web.test/api/main/${segments.join('/')}?cursor=page`, {
    headers: { 'x-rezics-display-languages': '',
      'x-rezics-page-url': 'https://web.test/en', 'accept-language': 'en' },
    credentials: 'omit',
  }), segments, { mainOrigin: 'https://main.test', accessToken: undefined,
    fetch: (async (_input, init) => {
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({});
    }) as typeof fetch });
  expect(upstreamHeaders.has('x-rezics-display-languages')).toBe(false);
  expect(upstreamHeaders.has('accept-language')).toBe(false);
});

test('signed-in thread continuation language selection stays with Main preferences', async () => {
  let upstreamHeaders = new Headers();
  await forwardToMain(new Request(`https://web.test/api/main/${segments.join('/')}?cursor=page`, {
    headers: { 'x-rezics-display-languages': 'ja',
      'x-rezics-page-url': 'https://web.test/en', 'accept-language': 'en' },
  }), segments, { mainOrigin: 'https://main.test', accessToken: 'signed-in-thread-test',
    fetch: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/v1/me/session-agent') return Response.json({
        sessionAgent: { eligible: true, actingSubject: 'https://rezics.com/id/00000000-0000-4000-a000-000000000003' },
      });
      if (url.pathname === '/v1/me/person-preferences') return Response.json({ contentLanguages: ['fr'] });
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({});
    }) as typeof fetch });
  expect(upstreamHeaders.get('x-rezics-display-languages')).toBe('fr,en');
  expect(upstreamHeaders.get('authorization')).toBe('Bearer signed-in-thread-test');
});
