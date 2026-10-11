import { expect, test } from 'bun:test';
import { imageReferenceFromUrl, mediaMetadataOf, resolveMediaMetadata } from '../features/api/media-metadata.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaImageProvider, mediaImageKey, type MediaImageViewer } from '@rezics/ui/media-image';
import { CatalogueCover } from '../features/catalogue/cover.tsx';
import { CoverLink, WorkTile } from '../features/catalogue/work-tile.tsx';
import { classics } from '../features/catalogue/fixtures.ts';
import { coverImage, type CatalogueWork } from '../features/catalogue/work.ts';
import { knownCoverCredit } from '../features/rights-mark/fixtures.ts';
import { StudioCover } from '../features/studio/studio-cover.tsx';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const imported: CatalogueWork = { ...classics[0]!, cover: {
  kind: 'image', selection: id(1), url: `/v1/media/representations/${id(2)}/bytes?use=${id(3)}`,
  width: 300, height: 450, mediaType: 'image/png', crop: null,
  basis: { policy: 'test', context: 'test' },
  coverCredit: knownCoverCredit,
} };
const viewer: MediaImageViewer = { ready: true, signedIn: false, age: 'unknown',
  optIns: { general: true, r15: false, sexual: false, grotesque: false } };

test('cover metadata and selected props round-trip exact copyright evidence and permitted role', async () => {
  const ref = { representationId: id(2), mediaUseId: id(3) };
  for (const holder of [knownCoverCredit.holder, null]) {
    const credit = { ...knownCoverCredit, holder };
    const descriptor = { status: 'available' as const, representation: id(2), use: id(3),
      url: `/v1/media/representations/${id(2)}/bytes?use=${id(3)}`, nsfw: 'sfw' as const,
      ageRating: { status: 'unassessed' as const }, conceal: false, coverCredit: credit };
    const send = (async () => Response.json({ items: [descriptor] })) as unknown as typeof fetch;
    expect((await resolveMediaMetadata([ref], null, send))[0]?.coverCredit).toEqual(credit);
    expect(coverImage({ ...imported.cover as Extract<CatalogueWork['cover'], { kind: 'image' }>, coverCredit: credit })?.coverCredit).toEqual(credit);
    expect(mediaMetadataOf([{ ...descriptor, coverCredit: null }], [ref])[0]?.coverCredit).toBeNull();
  }
  expect(mediaMetadataOf([{ status: 'unavailable' }], [ref])).toEqual([]);
});

test('identifying covers render accessible credit beside headers and compact Work links in server output', () => {
  for (const element of [createElement(CatalogueCover, { work: imported, locale: 'ja' }),
    createElement(CoverLink, { work: imported, locale: 'ja' }),
    createElement(StudioCover, { id: imported.id, title: imported.title!, cover: imported.cover,
      types: ['https://schema.org/Book'], authors: [], actingSubject: 'person' }),
    createElement(WorkTile, { work: imported, locale: 'ja' })]) {
    const html = renderToStaticMarkup(element);
    expect(html).toContain('data-cover-credit');
    expect(html).toContain(`href="${knownCoverCredit.source.href}"`);
    expect(html).not.toMatch(/<a\b[^>]*aria-hidden="true"[^>]*>(?:(?!<\/a>).)*data-cover-credit/s);
    expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>).)*<a\b[^>]*>/s);
  }
});

test('generated, hidden and refreshed unavailable covers render no stale copyright mark', () => {
  expect(renderToStaticMarkup(createElement(CatalogueCover, { work: classics[0]! }))).not.toContain('data-cover-credit');
  const image = coverImage(imported.cover)!;
  const reference = { representationId: image.representationId!, mediaUseId: image.mediaUseId };
  for (const metadata of [null, { ...reference, nsfw: 'sfw' as const, coverCredit: knownCoverCredit,
    ageRating: { status: 'assessed' as const, labels: ['r18' as const] } }]) {
    const html = renderToStaticMarkup(createElement(MediaImageProvider, { viewer,
      images: { [mediaImageKey(reference)]: metadata },
      children: createElement(CatalogueCover, { work: imported }) }));
    expect(html).not.toContain('data-cover-credit');
    expect(html).not.toContain('data-slot="media-image"');
  }
});
test('selected media resolves canonical identities while retaining its request cache grain', async () => {
  const ref = imageReferenceFromUrl(`/api/main/v1/media/avatars/${id(1)}?actingSubject=person`)!;
  let request: Record<string, unknown> | undefined;
  const send = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body));
    return Response.json({ items: [{ status: 'available', representation: id(2), use: id(3),
      url: `/v1/media/representations/${id(2)}/bytes?use=${id(3)}`, nsfw: 'nsfw',
      ageRating: { status: 'unassessed' }, conceal: false, controls: { conceal: null }, canEdit: true }] });
  }) as unknown as typeof fetch;
  const [image] = await resolveMediaMetadata([ref], 'person', send);
  expect(request?.items).toEqual([{ selection: id(1) }]);
  expect(image).toMatchObject({ representationId: id(2), mediaUseId: id(3), requestKey: `selection:${id(1)}:` });
  expect(image?.src).toContain('actingSubject=person');
  expect(image?.controls?.conceal).toBeUndefined();
});

test('direct image Uses stay distinct and incomplete metadata cannot silently succeed', async () => {
  const ref = imageReferenceFromUrl(`/v1/media/representations/${id(2)}/bytes?use=${id(3)}`)!;
  expect(ref).toEqual({ representationId: id(2), mediaUseId: id(3) });
  for (const origin of ['https://rezics.com', '//rezics.com', 'HTTPS://rezics.com', 'https://a.b.rezics.com/discard/..']) {
    expect(imageReferenceFromUrl(`${origin}/v1/media/representations/${id(2)}/bytes?use=${id(3)}`)).toEqual(ref);
  }
  expect(imageReferenceFromUrl(`https://example.org/v1/media/representations/${id(2)}/bytes`)).toBeUndefined();
  const send = (async () => Response.json({ items: [] })) as unknown as typeof fetch;
  await expect(resolveMediaMetadata([ref], null, send)).rejects.toThrow('Incomplete');
  await expect(resolveMediaMetadata(Array.from({ length: 65 }, () => ref), null, send)).rejects.toThrow('64');
});
