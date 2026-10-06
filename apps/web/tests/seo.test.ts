import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import type { Metadata } from 'next';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { workAsyncStorage, type WorkStore } from 'next/dist/server/app-render/work-async-storage.external.js';
import { workUnitAsyncStorage, type RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external.js';
import { SERVER_DEADLINE_HEADER } from '../features/api/server-fetch.ts';
import { localeAlternates } from '../features/seo/address.ts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type WorkView, workMetadata, workPageMetadata, workTitle, workViewAddress } from '../features/seo/work.ts';
import { metadataOnlyWork, work as header, workRef as id } from '../features/work-page/fixtures.ts';
import type { WorkResolution } from '../features/work-page/read.ts';
import { uiLocales } from '../i18n/define.ts';

const realm = '7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a';
const chapter = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const origin = 'https://rezics.test';
const work: WorkResolution = { kind: 'work', id, header };

describe('Work view addresses', () => {
  test('keep the selection the page shows and drop what it ignores', () => {
    expect(workViewAddress(id, { tab: 'overview' }, { utm_source: 'feed' })).toEqual({
      path: resourceHref('/w/', id),
      indexable: true,
    });
    expect(
      workViewAddress(id, { tab: 'overview' }, { scope: 'realm', realm, context: realm }),
    ).toEqual({
      path: `${resourceHref('/w/', id)}?scope=realm&realm=${realm}&context=${realm}`,
      indexable: true,
    });
    expect(
      workViewAddress(id, { tab: 'discussion' }, { scope: 'realm', realm, context: realm }),
    ).toEqual({
      path: `${resourceHref('/w/', id)}/discussion?scope=realm&realm=${realm}`,
      indexable: true,
    });
    expect(workViewAddress(id, { tab: 'versions' }, { language: 'EN', kind: 'release' })).toEqual({
      path: `${resourceHref('/w/', id)}/versions?kind=release&language=en`,
      indexable: true,
    });
    expect(workViewAddress(id, { tab: 'contents' }, { parent: chapter })).toEqual({
      path: `${resourceHref('/w/', id)}/contents?parent=${chapter}`,
      indexable: true,
    });
    expect(workViewAddress(id, { tab: 'history' }, { kind: 'metadata-revision' })).toEqual({
      path: `${resourceHref('/w/', id)}/history?kind=metadata-revision`,
      indexable: true,
    });
    expect(workViewAddress(id, { tab: 'read', chapter }, { language: 'ja' })).toEqual({
      path: `${resourceHref('/w/', id)}/read/${chapter}?language=ja`,
      indexable: true,
    });
  });

  test('never index a personal view, an expiring cursor or a selection the page refuses', () => {
    expect(workViewAddress(id, { tab: 'overview' }, { scope: 'mine' })).toEqual({
      path: `${resourceHref('/w/', id)}?scope=mine`,
      indexable: false,
    });
    expect(workViewAddress(id, { tab: 'versions' }, { cursor: 'c1' })).toEqual({
      path: `${resourceHref('/w/', id)}/versions`,
      indexable: false,
    });
    expect(workViewAddress(id, { tab: 'discussion' }, { cursor: 'c1' })).toEqual({
      path: `${resourceHref('/w/', id)}/discussion`,
      indexable: false,
    });
    const refused: [WorkView, Record<string, string | string[]>][] = [
      [{ tab: 'overview' }, { scope: 'everyone' }],
      [{ tab: 'contents' }, { parent: 'x' }],
      [{ tab: 'history' }, { kind: 'all' }],
      [{ tab: 'versions' }, { language: ['en', 'ja'] }],
      [{ tab: 'read', chapter }, { language: '%%' }],
    ];
    for (const [view, query] of refused) {
      const base =
        view.tab === 'read'
          ? `${resourceHref('/w/', id)}/read/${chapter}`
          : `${resourceHref('/w/', id)}${view.tab === 'overview' ? '' : `/${view.tab}`}`;
      expect(workViewAddress(id, view, query)).toEqual({ path: base, indexable: false });
    }
  });
});

describe('Work metadata', () => {
  test('a public Work is canonical at its native ID in every UI locale, with its own description', () => {
    const metadata = workMetadata(
      work,
      { tab: 'overview' },
      { scope: 'realm', realm },
      'zh-Hant',
      origin,
    );
    const canonical = `${origin}${localizedPath(`${resourceHref('/w/', id)}?scope=realm&realm=${realm}`, 'zh-Hant')}`;
    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates).toEqual(
      localeAlternates(origin, `${resourceHref('/w/', id)}?scope=realm&realm=${realm}`, 'zh-Hant'),
    );
    expect(metadata.alternates?.canonical).toBe(canonical);
    expect(Object.keys(metadata.alternates?.languages ?? {})).toEqual([...uiLocales]);
    expect(metadata.description).toBe(header.description!.value);
    expect(metadata.openGraph).toEqual({
      siteName: 'REZICS',
      title: header.title.value,
      description: header.description!.value,
      url: canonical,
    });
  });

  test('a public cover becomes an absolute preview image through the BFF; a generated one gives none', () => {
    const cover = {
      kind: 'image' as const,
      selection: 's',
      url: '/v1/media/avatars/s',
      mediaType: 'image/webp',
      width: 600,
      height: 900,
      crop: null,
      basis: { policy: 'p', context: 'c' },
    };
    const metadata = workMetadata(
      { ...work, header: { ...header, cover, description: null } },
      { tab: 'contents' },
      {},
      'en',
      origin,
    );
    expect(metadata.description).toBe(header.tagline!.value);
    expect(metadata.openGraph).toMatchObject({
      images: [
        {
          url: `${origin}/api/main/v1/media/avatars/s`,
          width: 600,
          height: 900,
          alt: header.title.value,
        },
      ],
    });
    expect(workMetadata(work, { tab: 'overview' }, {}, 'en', origin).openGraph).not.toHaveProperty(
      'images',
    );
  });

  test('VIEW07: a restricted Work gives no description, preview or index entry, even to a reader who may see it', () => {
    const metadata = workMetadata(
      { kind: 'work', id, header: metadataOnlyWork },
      { tab: 'overview' },
      {},
      'en',
      origin,
    );
    expect(metadata).toEqual({
      robots: { index: false },
      alternates: localeAlternates(origin, resourceHref('/w/', id), 'en'),
    });
  });

  test('an unavailable Work is not indexed; a missing one is left to the not-found view', () => {
    expect(workMetadata({ kind: 'unavailable' }, { tab: 'overview' }, {}, 'en', origin)).toEqual({
      robots: { index: false },
    });
    expect(workMetadata({ kind: 'missing' }, { tab: 'overview' }, {}, 'en', origin)).toEqual({});
    expect(
      workMetadata({ kind: 'moved', key: 'new-slug' }, { tab: 'overview' }, {}, 'en', origin),
    ).toEqual({});
  });

  test('without a known origin the metadata carries no address', () => {
    const metadata = workMetadata(work, { tab: 'overview' }, { scope: 'mine' }, 'en', null);
    expect(metadata).not.toHaveProperty('alternates');
    expect(metadata.robots).toEqual({ index: false });
    expect(metadata.openGraph).not.toHaveProperty('url');
  });
});

describe('Anonymous Work metadata', () => {
  const nativeFetch = globalThis.fetch;
  const mainOrigin = process.env.MAIN_ORIGIN;
  afterEach(() => {
    globalThis.fetch = nativeFetch;
    if (mainOrigin === undefined) delete process.env.MAIN_ORIGIN;
    else process.env.MAIN_ORIGIN = mainOrigin;
  });

  /** Renders a page's metadata for a request that carries a signed-in session, and records what Main was asked. */
  async function render(personal: WorkResolution, answer: (url: URL) => unknown, run?: () => Promise<void>) {
    process.env.MAIN_ORIGIN = 'http://main.test';
    const asked: { url: URL; authorization: string | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      asked.push({ url, authorization: headers.get('authorization') });
      const body = answer(url);
      return body === undefined ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json(body);
    }) as unknown as typeof fetch;
    const headers = new Headers({ [SERVER_DEADLINE_HEADER]: String(Date.now() + 5000),
      'x-rezics-page-url': `https://rezics.test/en${resourceHref('/w/', id)}` });
    const cookies = { get: (name: string) => name === 'rezics_access' ? { value: 'reader-token' }
      : name === 'rezics_session_key' ? { value: '10280000-0000-4000-8000-000000000001' } : undefined };
    const store = spyOn(workAsyncStorage, 'getStore').mockReturnValue({ route: '/en/w' } as WorkStore);
    const request = spyOn(workUnitAsyncStorage, 'getStore').mockReturnValue(
      { type: 'request', phase: 'render', headers, cookies } as RequestStore);
    try { return run ? (await run(), { metadata: {} as Metadata, asked }) : { metadata: await workPageMetadata(personal, { tab: 'overview' }, {}, 'en'), asked }; }
    finally { store.mockRestore(); request.mockRestore(); }
  }

  const personalised: WorkResolution = { kind: 'work', id,
    header: { ...header, title: { ...header.title, value: 'Private edition for the signed-in reader' } } };
  const anonymous = { ...header, title: { ...header.title, value: 'The public title' } };
  const publicAnswers = (url: URL) => url.pathname === `/v1/public-previews/${id}` ? { profile: 'public-preview-v1', status: 'available' }
    : url.pathname === `/v1/works/${id}` ? anonymous : undefined;

  test('crawlers get the anonymous representation even while the request carries a session', async () => {
    const { metadata, asked } = await render(personalised, publicAnswers);
    expect(metadata.openGraph).toMatchObject({ title: 'The public title' });
    expect(JSON.stringify(metadata)).not.toContain('Private edition');
    expect(asked.map(call => call.url.pathname).sort()).toEqual([`/v1/public-previews/${id}`, `/v1/works/${id}`].sort());
  });

  test('no token and no private language preference are sent for an anonymous render', async () => {
    const { asked } = await render(personalised, publicAnswers);
    expect(asked.every(call => call.authorization === null)).toBe(true);
    expect(asked.some(call => call.url.pathname.startsWith('/v1/me/'))).toBe(false);
  });

  /** The title `workTitle` gives for a request that carries a session. */
  async function titleOf(personal: WorkResolution, answer: (url: URL) => unknown, section?: string) {
    let title = '';
    await render(personal, answer, async () => { title = await workTitle(personal, section); });
    return title;
  }

  test('page titles come from the anonymous read, never the personalized Work', async () => {
    expect(await titleOf(personalised, publicAnswers)).toBe('The public title');
    expect(await titleOf(personalised, publicAnswers, 'History')).toBe('History · The public title');
  });

  test('a Work that is not public to everyone never gives its title, only its section or the site name', async () => {
    const privateWork = (url: URL) => url.pathname === `/v1/works/${id}` ? anonymous : undefined;
    expect(await titleOf(personalised, privateWork)).toBe('REZICS');
    expect(await titleOf(personalised, privateWork, 'History')).toBe('History');
    expect(await titleOf({ kind: 'missing' }, publicAnswers)).toBe('REZICS');
  });

  test('no Work page or Zone route publishes the title of the personalized Work read', () => {
    const web = join(import.meta.dir, '..');
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(web, 'app/[locale]/w'));
    files.push(join(web, 'features/zones/site-route.tsx'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const metadata = source.slice(source.search(/export async function (generateMetadata|zoneSiteMetadata)/));
      if (!/export async function (generateMetadata|zoneSiteMetadata)/.test(source)) continue;
      const body = metadata.slice(0, metadata.search(/\n}\n/));
      expect({ file, leak: /header\.title/.test(body) }).toEqual({ file, leak: false });
    }
  });

  test('a Work that is not public to anyone is left undisclosed', async () => {
    const { metadata } = await render(personalised, url => url.pathname === `/v1/works/${id}` ? anonymous : undefined);
    expect(metadata).toMatchObject({ title: { absolute: 'REZICS' }, robots: { index: false } });
  });
});
