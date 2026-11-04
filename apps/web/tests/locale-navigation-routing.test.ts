import { expect, test } from 'bun:test';
import { deriveLocaleDestinations, type LocaleNavigationLocation } from '../src/shell/locale-navigation/routing';

function location(pathname: string, searchStr = '', hash = '', supported = true): LocaleNavigationLocation {
  return { pathname, searchStr, hash, locale: 'en', visitKey: `${pathname}${searchStr}${hash}`, supported };
}

function destination(pathname: string, searchStr: string, hash: string, locale: string) {
  return deriveLocaleDestinations(location(pathname, searchStr, hash)).find((entry) => entry.locale === locale)!;
}

test('same-page locale links preserve Subject, Search, and Collection query intent through Paraglide routing', () => {
  const intent = '?return_to=%2Fsearch%3Fq%3D%E6%9C%88%E3%81%AE%E5%85%89&view=latest';
  const examples = [
    ['/subjects/01J8READER0000000000000001', intent, '#chapter-4'],
    ['/search/list', '?q=%E6%98%9F%E7%A9%BA&filter=type%3Amanga', '#results'],
    ['/collections/01J8COLLECTION000000000001', '?sort=updated&cursor=next%2Fpage', '#item-7'],
  ] as const;

  for (const [pathname, search, hash] of examples) {
    for (const locale of ['en', 'zh-Hant', 'ja']) {
      expect(destination(pathname, search, hash, locale)).toMatchObject({
        href: `/${locale}${pathname}${search}${hash}`,
        pathname,
        searchStr: search,
        hash,
        kind: 'page',
      });
    }
  }

  expect(destination('/subjects/reader', '?q=chapter%202', '#line-2', 'zh-Hant').href).toBe(
    '/zh-Hant/subjects/reader?q=chapter%202#line-2',
  );
});

test('SSR destinations omit an unseen fragment while keeping the supported query', () => {
  const entries = deriveLocaleDestinations(location('/search/list', '?q=moon%20light', '#results'), false);
  expect(entries.find((entry) => entry.locale === 'ja')).toMatchObject({
    href: '/ja/search/list?q=moon%20light',
    hash: '',
    kind: 'page',
  });
});

test('external, machine, OIDC, signed, and unsafe return destinations use only the locale home', () => {
  const unsafe = [
    location('https://foreign.example/subjects/reader'),
    location('/_serverFn/read', '?return_to=%2Fsubjects%2Freader'),
    location('/api/search/suggestions', '?q=reader'),
    location('/auth/callback', '?state=opaque'),
    location('/oidc/authorize', '?client_id=app&response_type=code'),
    location('/media/download/file', '?signature=signed'),
    location('/subjects/reader', '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=key&X-Amz-Signature=signed'),
    location('/subjects/reader', '?return_to=https%3A%2F%2Fforeign.example%2F'),
    location('/subjects/reader', '?return_to=%2Fauth%2Fcallback%3Fstate%3Dopaque'),
  ];

  for (const current of unsafe) {
    const entries = deriveLocaleDestinations(current);
    expect(entries).toHaveLength(8);
    expect(entries.every((entry) => entry.kind === 'home')).toBe(true);
    expect(entries.every((entry) => entry.href.startsWith('/') && !entry.href.startsWith('//'))).toBe(true);
    expect(entries.some((entry) => entry.href.includes('foreign.example'))).toBe(false);
  }
});

test('private reader links carry only local route intent so the destination can re-admit the viewer', () => {
  const current = location('/library/diary', '?cursor=older%2Fpage', '#entry-9');
  const japanese = deriveLocaleDestinations(current).find((entry) => entry.locale === 'ja')!;
  expect(japanese).toEqual({
    locale: 'ja',
    href: '/ja/library/diary?cursor=older%2Fpage#entry-9',
    pathname: '/library/diary',
    searchStr: '?cursor=older%2Fpage',
    hash: '#entry-9',
    kind: 'page',
  });
  expect(japanese).not.toHaveProperty('session');
  expect(japanese).not.toHaveProperty('principal');
  expect(japanese).not.toHaveProperty('response');
});
