import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { forwardToMain } from '../features/api/bff.ts';
import { parseFeedState } from '../features/feed/state.ts';
import { commonLanguages } from '../features/onboarding/languages.ts';
import { CONTENT_LANGUAGE_LIMIT, CONTENT_LANGUAGES_COOKIE, contentLanguageCookie }
  from '../i18n/display-languages.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('G-597 feed filters keep Main\'s languages in order, past the old cap of eight', () => {
  expect(parseFeedState({ lang: 'ja,ko,yue-Hant,klingon' }, true).languages).toEqual(['ja', 'ko', 'yue-Hant']);
  const many = commonLanguages.slice(0, CONTENT_LANGUAGE_LIMIT + 1);
  expect(parseFeedState({ lang: many.join(',') }, true).languages).toEqual([...many.slice(0, CONTENT_LANGUAGE_LIMIT)]);
});

test('G-597 signed-in display languages come from Main, not the cookie or a client header', async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const actor = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, headers });
    if (url.endsWith('/v1/me/session-agent')) {
      return Response.json({ sessionAgent: { actingSubject: actor, eligible: true } });
    }
    if (url.includes('/v1/me/person-preferences')) {
      return Response.json({ contentLanguages: ['ja', 'ko', 'yue-Hant'] });
    }
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const response = await forwardToMain(new Request('http://web.test/api/main/v1/works?x=1', { headers: {
    'x-rezics-display-languages': 'de,fr', 'accept-language': 'en',
    'x-rezics-page-url': 'https://rezics.test/en/w',
    cookie: `${CONTENT_LANGUAGES_COOKIE}=${contentLanguageCookie(['de', 'fr'])}` } }),
  ['v1', 'works'], { mainOrigin: 'http://main.test', accessToken: 'g-597-reader', fetch: fetchImpl });
  expect(response.status).toBe(200);
  const forwarded = seen.find(call => call.url.startsWith('http://main.test/v1/works'));
  expect(forwarded?.headers.get('x-rezics-display-languages')).toBe('ja,ko,yue-Hant,en');
  expect(forwarded?.headers.get('accept-language')).toBe('ja,ko,yue-Hant,en');
  expect(forwarded?.headers.get('cookie')).toBeNull();
});

test('G-597 a signed-out request still uses the cookie and does not ask Main for a profile', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(input));
    return Response.json({ header: new Headers(init?.headers).get('x-rezics-display-languages') });
  }) as unknown as typeof fetch;
  const response = await forwardToMain(new Request('http://web.test/api/main/v1/works', { headers: {
    'x-rezics-display-languages': 'de', 'accept-language': 'fr',
    'x-rezics-page-url': 'https://rezics.test/en',
    cookie: `${CONTENT_LANGUAGES_COOKIE}=${contentLanguageCookie(['zh-Hans', 'yue-Hant'])}` } }),
  ['v1', 'works'], { mainOrigin: 'http://main.test', accessToken: undefined, fetch: fetchImpl });
  expect(response.status).toBe(200);
  expect(seen).toEqual(['http://main.test/v1/works']);
  expect(await response.json()).toEqual({ header: 'zh-Hans,yue-Hant,en,fr' });
});

test('G-597 signed-in display languages are not read from the cookie in the web clients', () => {
  const main = source('../features/api/main.ts');
  const browser = source('../features/api/browser.ts');
  const bff = source('../features/api/bff.ts');
  const settings = source('../features/settings/settings-sections.tsx');
  expect(main).toContain('displayLanguageHeaders');
  expect(main).not.toContain('storedContentLanguages');
  expect(main).not.toContain('saved.length');
  expect(browser).not.toContain('CONTENT_LANGUAGES_COOKIE');
  expect(browser).not.toContain('storedContentLanguages');
  expect(bff).toContain('displayLanguageHeaders');
  expect(bff).not.toContain('storedContentLanguages');
  expect(settings).not.toContain('CONTENT_LANGUAGES_COOKIE');
  expect(settings).not.toContain('document.cookie');
  expect(settings).toContain('LanguagePicker');
  expect(settings).toContain('expectedVersion: current.version');
});
