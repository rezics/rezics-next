import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type MediaImageMetadata,
  MediaImageProvider,
  type MediaImageViewer,
  mediaImageKey,
  ResolvedMediaImages,
} from '@rezics/ui/media-image';
import type { ZoneShowcaseArt, ZoneShowcaseSlide } from '@rezics/zone-sdk';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { imageReferenceFromUrl } from '../features/api/media-metadata.ts';
import { campaignShowcaseArt, deliveredShowcaseImage, workShowcaseArt } from '../features/realm/adapt.ts';
import { readHeroImages } from '../features/realm/modules.ts';
import { Background, ShowcasePreload } from '../features/showcase/slide.tsx';
import type { PlacedModule } from '../features/zones/zone-home.tsx';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const anonymous: MediaImageViewer = { ready: true, signedIn: false, age: 'unknown', nsfwDisplay: 'mask',
  optIns: { general: true, r15: false, sexual: false, grotesque: false } };

/** Main's showcase image: an original with a rendition ladder, both named by representation and Use. */
function delivered(representation: number, use: number) {
  return deliveredShowcaseImage({
    url: `/v1/media/representations/${uuid(representation)}/bytes?use=${uuid(use)}`, width: 1920, height: 1080,
    crop: null, srcset: [{ url: `/v1/media/representations/${uuid(representation + 100)}/bytes?use=${uuid(use)}`,
      width: 640, type: 'image/webp' }],
  });
}
const landscape = delivered(1, 11);
const portrait = deliveredShowcaseImage({
  url: `/v1/media/representations/${uuid(2)}/bytes?use=${uuid(12)}`, width: 960, height: 1280, crop: null,
  srcset: [{ url: `/v1/media/representations/${uuid(102)}/bytes?use=${uuid(12)}`, width: 640, type: 'image/webp' }],
});
const art: ZoneShowcaseArt = { landscape, portrait };

/** Metadata as `readShowcaseImages` keys it, from an image's URL. */
function resolved(url: string, labels: Partial<MediaImageMetadata> = {}): [string, MediaImageMetadata] {
  const reference = imageReferenceFromUrl(url)!;
  return [mediaImageKey(reference), { ...reference, requestKey: mediaImageKey(reference), src: url,
    nsfw: 'sfw', ageRating: { status: 'unassessed' }, conceal: false, ...labels }];
}
const render = (node: ReactNode, images: Record<string, MediaImageMetadata> = {}, viewer = anonymous) =>
  renderToStaticMarkup(
    <MediaImageProvider viewer={viewer} referenceFromUrl={imageReferenceFromUrl} resolve={async () => []}>
      <ResolvedMediaImages images={images}>{node}</ResolvedMediaImages>
    </MediaImageProvider>,
  );
const slide: ZoneShowcaseSlide = { id: 'first', href: '#first', title: { value: 'First', lang: 'en', dir: 'ltr' },
  art };
const candidate = (image: typeof landscape) => image.candidates![0]!.url;

test('the first slide is a real image in the server HTML once the server resolved its metadata, and it is the preload', () => {
  const images = Object.fromEntries([resolved(landscape.url), resolved(portrait.url)]);
  const html = render(<Background art={art} first />, images);
  expect(html).toContain('<img');
  expect(html).toContain('class="showcase-art"');
  expect(html).toContain('fetchPriority="high"');
  expect(html).not.toContain('media-image-placeholder');
  expect(html).toContain(candidate(landscape));
  expect(html).toContain(candidate(portrait));
  const preload = render(<ShowcasePreload slide={slide} />, images);
  expect(preload).toContain('rel="preload"');
  expect(preload).toContain(candidate(landscape));
  expect(preload).toContain(candidate(portrait));
});

test('authored alt is exposed once on the framed copy, and art without it stays hidden from assistive technology', () => {
  const images = Object.fromEntries([resolved(landscape.url), resolved(portrait.url)]);
  const described = render(<Background art={{ ...art, landscape: { ...landscape, alt: 'A tide under stars' } }}
    first />, images);
  expect(described.match(/alt="A tide under stars"/g)).toHaveLength(1);
  expect(described).not.toContain('class="showcase-background" aria-hidden');
  expect(described).toContain('aria-hidden="true" class="showcase-image-frame showcase-ambient"');
  const plain = render(<Background art={art} first />, images);
  expect(plain).toContain('aria-hidden="true" class="showcase-background"');
  expect(plain).not.toMatch(/alt="[^"]/);
});

test('unresolved art waits for metadata without fetching anything: no source, image or preload', () => {
  const html = render(<Background art={art} first />);
  expect(html).toContain('media-image-placeholder');
  expect(html).not.toContain('<img');
  expect(html).not.toContain(candidate(landscape));
  expect(render(<ShowcasePreload slide={slide} />)).toBe('');
});

test('masked art is masked in the server HTML, and none of its bytes are referenced', () => {
  const cases: Array<[string, Partial<MediaImageMetadata>]> = [
    ['NSFW', { nsfw: 'nsfw' }],
    ['not assessed for NSFW', { nsfw: 'unknown' }],
    ['concealed by its Use', { conceal: true }],
    ['age rated', { ageRating: { status: 'assessed', labels: ['r18'] } }],
  ];
  for (const [name, labels] of cases) {
    const images = Object.fromEntries([resolved(landscape.url, labels), resolved(portrait.url, labels)]);
    const html = render(<Background art={art} first />, images);
    expect(html, name).not.toContain('<img');
    expect(html, name).not.toContain(candidate(landscape));
    expect(html, name).not.toContain(candidate(portrait));
    expect(html, name).toMatch(/media-image-(mask|placeholder)/);
    expect(render(<ShowcasePreload slide={slide} />, images), name).toBe('');
  }
  // The reader's own preference is applied on the server too.
  const nsfw = Object.fromEntries([resolved(landscape.url, { nsfw: 'nsfw' }), resolved(portrait.url, { nsfw: 'nsfw' })]);
  expect(render(<Background art={art} first />, nsfw, { ...anonymous, signedIn: true, nsfwDisplay: 'show' }))
    .toContain(candidate(landscape));
});

test('each window\'s background passes the policy itself: a masked portrait is never a source', () => {
  const images = Object.fromEntries([resolved(landscape.url), resolved(portrait.url, { nsfw: 'nsfw' })]);
  const html = render(<Background art={art} first />, images);
  expect(html).toContain('<img');
  expect(html).toContain(candidate(landscape));
  expect(html).not.toContain(candidate(portrait));
  const preload = render(<ShowcasePreload slide={slide} />, images);
  expect(preload).toContain(candidate(landscape));
  expect(preload).not.toContain(candidate(portrait));
  // A masked landscape leaves the portrait drawing every window.
  const flipped = Object.fromEntries([resolved(landscape.url, { nsfw: 'nsfw' }), resolved(portrait.url)]);
  const other = render(<Background art={art} first />, flipped);
  expect(other).toContain(candidate(portrait));
  expect(other).not.toContain(candidate(landscape));
});

test('showcase art URLs name no reader, so every reader shares one cached copy', () => {
  for (const url of [landscape.url, ...landscape.candidates!.map(item => item.url)]) {
    expect(url).toStartWith('/api/main/v1/media/representations/');
    expect(url).not.toContain('actingSubject');
  }
  const image = { role: 'background-landscape' as const, selection: uuid(3), asset: uuid(4), use: uuid(11),
    representation: uuid(1), context: 'urn:rezics:media:context:default', mediaType: 'image/png',
    url: `/v1/media/representations/${uuid(1)}/bytes?use=${uuid(11)}`, width: 1920, height: 1080,
    cropWidth: 1920, cropHeight: 1080, crop: null, focalArea: null, srcset: [] };
  expect(workShowcaseArt({ reference: uuid(5), status: 'available', images: [image], trailer: null }).landscape?.url)
    .toBe(`/api/main${image.url}`);
  const campaign = campaignShowcaseArt('hero', [{ id: 'hero', art: { landscape: { use: `https://rezics.com/id/${uuid(11)}`,
    url: image.url, width: 1920, height: 1080, cropWidth: 1920, cropHeight: 1080, crop: null, mediaType: 'image/png',
    srcset: [] }, portrait: null, cutout: null, logos: [] } }]);
  expect(campaign?.landscape?.url).toBe(`/api/main${image.url}`);
});

test('a Zone home reads the metadata of its heroes\' images in one batch, first slide first', async () => {
  const cutout = delivered(6, 16);
  const logo = { ...delivered(7, 17), tone: 'light' as const, anchor: 'start-bottom' as const, language: '' };
  const cover = { url: `/api/main/v1/media/avatars/${uuid(8)}?actingSubject=x`, width: 600, height: 900 };
  const work = (id: number, showcaseArt: ZoneShowcaseArt | null) => ({ id: `https://rezics.com/id/${uuid(id)}`,
    href: '#work', title: null, cover, kind: 'book' as const, author: null, tagline: null, status: null, chapters: null,
    words: null, updatedAt: null, decision: null, showcaseArt });
  const hero = { module: { type: 'hero-carousel' }, state: { state: 'ready', data: { slides: [
    { ...slide, art: null, work: work(20, { ...art, cutout, logos: [logo] }) },
    { ...slide, id: 'second', art: null, work: work(21, null) },
  ] } } } as unknown as PlacedModule;
  const shelf = { module: { type: 'shelf' }, state: { state: 'ready', data: { tabs: [] } } } as unknown as PlacedModule;
  let requested: readonly string[] = [];
  const images = await readHeroImages([shelf, hero], 'en', async urls => { requested = urls; return {}; });
  expect(images).toEqual({});
  expect(requested).toEqual([landscape.url, portrait.url, cutout.url, logo.url, cover.url]);
});

test('the reads a server render runs take no values from client modules, which throw when called there', () => {
  const web = join(import.meta.dir, '..');
  for (const file of ['features/api/showcase.ts', 'features/api/media-metadata.ts', 'features/realm/modules.ts',
    'features/showcase/stage.ts']) {
    for (const [, names, module] of readFileSync(join(web, file), 'utf8')
      .matchAll(/^import\s+(?!type\b)\{([^}]*)\}\s+from\s+'@rezics\/ui\/([\w-]+)'/gm)) {
      if (names!.split(',').every(name => !name.trim() || name.trim().startsWith('type '))) continue;
      const source = readFileSync(join(web, '../../packages/ui/src/components', `${module}.tsx`), 'utf8');
      expect(source.trimStart().startsWith("'use client'"), `${file} calls @rezics/ui/${module}`).toBe(false);
    }
  }
});
