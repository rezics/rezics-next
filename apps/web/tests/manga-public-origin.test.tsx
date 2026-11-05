import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { candidateContext } from '../src/subject/candidates';
import { MangaProfileEntry } from '../src/features/catalogue/manga-profile-entry';
import { collectEditorialEntries } from '../src/features/catalogue/editorial-entry';
import { mangaGlobalVisitHref, mangaObservedOrigin, mangaPublicCorrectionHref, mangaPublicIntentFits,
  parseMangaPublicVisit, type MangaPublicOrigin } from '../src/features/catalogue/manga-public-visit';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const id = '00000000-0000-4000-8000-00000000d101';
const other = '00000000-0000-4000-8000-00000000d102';
const publicHref = `/en/subjects/${id}/comic`;
const base = `${publicHref}/manga`;
const origin: MangaPublicOrigin = { subject: id, type: 'schema:ComicSeries', context: candidateContext, returnHref: publicHref };
const parse = (href: string) => parseMangaPublicVisit(new URL(href, 'https://site.test').search, id, 'en', base);

test('actual Manga entry and contribution collector retain observed origin without reading producers or changing creation', () => {
  const entry = <MangaProfileEntry id={id} label="Comic" locale="en" origin={origin} />;
  const href = collectEditorialEntries(entry).entries[0]!.href;
  expect(renderToStaticMarkup(entry)).toContain('origin=');
  expect(parse(href)).toEqual({ kind: 'origin', origin });
  expect(renderToStaticMarkup(<MangaProfileEntry locale="en" />)).toContain('/en/catalogue/manga');
  expect(parse(base)).toBeUndefined();
});

test('HTTP origin admission rejects ambiguous, foreign, chained and encoded overbudget intent', () => {
  for (const value of [
    { ...origin, subject: other }, { ...origin, type: 'schema:Book' },
    { ...origin, context: 'invalid' }, { ...origin, assertion: other },
    { ...origin, returnHref: publicHref.replace('/en/', '/ja/') },
    { ...origin, returnHref: publicHref.replace(id, other) },
    { ...origin, returnHref: `https://site.test${publicHref}` },
    { ...origin, returnHref: `${publicHref}?via=${encodeURIComponent(publicHref)}` },
    { ...origin, returnHref: `${publicHref}?realm=${other}&realm=${other}` },
    { ...origin, returnHref: publicHref + '界'.repeat(700) },
  ]) expect(parse(`${base}?${new URLSearchParams({ origin: JSON.stringify(value) })}`)).toEqual({ kind: 'invalid' });
  const href = mangaPublicCorrectionHref(base, origin);
  for (const suffix of ['&origin=!', '&publicReturn=x', '&context=' + other, '#secret'])
    expect(parseMangaPublicVisit(new URL(href, 'https://site.test').search + suffix, id, 'en', base)).toEqual({ kind: 'invalid' });
  expect(parse(base + '?origin=%E0%A4%A')).toEqual({ kind: 'invalid' });
  expect(mangaPublicIntentFits('界'.repeat(700))).toBe(false);
  expect(mangaPublicIntentFits('x'.repeat(2048))).toBe(true);
  expect(mangaPublicCorrectionHref(base + '界'.repeat(180), origin)).toEndWith('?origin=!');
});

test('selected Context without Realm has honest unsupported exact return; deliberate Global keeps only compatible return', () => {
  const selected = mangaObservedOrigin({ ...origin, context: other });
  expect(selected.returnHref).toBeUndefined();
  expect(parse(mangaPublicCorrectionHref(base, selected))).toEqual({ kind: 'origin', origin: selected });
  const realm = { ...origin, context: other, realm: other, returnHref: `${publicHref}?realm=${other}` };
  expect(parse(mangaPublicCorrectionHref(base, realm))).toEqual({ kind: 'origin', origin: realm });
  const fresh = mangaGlobalVisitHref(id, 'en', realm.returnHref);
  expect(fresh).not.toContain('origin=');
  expect(parse(fresh)).toEqual({ kind: 'global', returnHref: realm.returnHref });
});

test('installed session refuses unsupported and malformed intent before mounting Global profile and nested transports', async () => {
  const { MangaProfileSession } = await import('../src/features/catalogue/manga-profile-session');
  const { m } = await import('../src/paraglide/messages');
  const client = new QueryClient();
  for (const visit of [parse(mangaPublicCorrectionHref(base, mangaObservedOrigin({ ...origin, context: other }))), { kind: 'invalid' } as const]) {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><MangaProfileSession id={id} locale="en" visit={visit} /></QueryClientProvider>);
    expect(html).toContain('role="alert"');
    expect(html).toContain(m.manga_origin_global({}, { locale: 'en' }));
    expect(html).not.toContain('<input');
    expect(client.getQueryCache().getAll().filter(q => q.queryKey[0] === 'manga-profile')).toHaveLength(0);
  }
  client.clear();
});
