import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { describe, expect, test } from 'bun:test';
import { localeAlternates } from '../features/seo/address.ts';
import { type WorkView, workMetadata, workViewAddress } from '../features/seo/work.ts';
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
