import { expect, test } from 'bun:test';
import type { ZoneShowcaseSlide, ZoneWork } from '@rezics/zone-sdk';
import type { WorkShowcase } from '../features/api/showcase.ts';
import { showcaseTargets } from '../features/api/showcase.ts';
import {
  deliveredShowcaseImage,
  liveSlides,
  presentationSlide,
  showcaseFocal,
  workShowcaseArt,
} from '../features/realm/adapt.ts';
import { enrichShowcaseModules } from '../features/realm/modules.ts';
import type { PlacedModule } from '../features/zones/zone-home.tsx';
import { defaultPresentation } from '../features/zones/presentation.ts';
import { focalFrame, slideArt } from '../features/showcase/stage.ts';
import { messages } from '../features/zones/messages.ts';

const target = 'https://rezics.com/id/00000000-0000-7000-8000-000000000001';
const realm = '00000000-0000-7000-8000-000000000002';
const work: ZoneWork = {
  id: target,
  href: '/work',
  title: { value: 'A Work', lang: 'en', dir: 'ltr' },
  cover: null,
  kind: 'book',
  tagline: null,
  author: null,
  chapters: null,
  words: null,
  status: null,
  updatedAt: null,
  decision: '/decision',
};
const image: WorkShowcase['images'][number] = {
  role: 'background-landscape',
  selection: realm,
  asset: realm,
  use: realm,
  representation: realm,
  context: `https://rezics.com/id/${realm}`,
  url: `/v1/media/representations/${realm}/bytes?use=${realm}`,
  mediaType: 'image/png',
  width: 1600,
  height: 900,
  cropWidth: 1600,
  cropHeight: 900,
  crop: null,
  focalArea: 'xywh=percent:60,20,20,50',
  srcset: [
    { url: '/v1/media/small.webp', width: 640, height: 360, type: 'image/webp' },
    { url: '/v1/media/small.avif', width: 640, height: 360, type: 'image/avif' },
  ],
};
const own: WorkShowcase = {
  reference: target,
  status: 'available',
  images: [image],
  trailer: {
    selection: realm,
    context: image.context,
    url: 'https://youtu.be/aqz-KE-bpKQ',
    provider: 'youtube',
  },
};

const hero = (slides: ZoneShowcaseSlide[]): PlacedModule => ({
  module: {
    id: 'hero',
    type: 'hero-carousel',
    title: 'Featured',
    rail: false,
    shuffle: false,
    layout: 'covers',
    more: null,
  },
  state: { state: 'ready', data: { slides } },
});

test('v2 defaults expose slides and the selected title treatment', () => {
  const presentation = defaultPresentation(messages, 'vibrant');
  expect(presentation.profile).toBe('zone-presentation-v2');
  expect(presentation.slides).toEqual([]);
  expect(presentation.tokens.titleEffect).toBe('glow');
});

test('scheduled Work and href slides keep their localized copy and target, independently of art', () => {
  const context = { locale: 'zh-Hant' as const, realm, ref: 'books' };
  const slide = {
    id: 'campaign',
    work: target,
    title: 'Default',
    titles: { 'zh-Hant': '新的故事' },
    kicker: 'New',
    kickers: { 'zh-Hant': '新作' },
  };
  const selected = presentationSlide(slide, work, context, [
    {
      id: slide.id,
      art: {
        landscape: {
          use: image.context,
          url: image.url,
          width: 1600,
          height: 900,
          crop: null,
          cropWidth: 1600,
          cropHeight: 900,
          mediaType: 'image/png',
          focalArea: image.focalArea!,
          alt: 'The cover of a new story',
          srcset: image.srcset,
        },
        portrait: null,
        cutout: null,
        logos: [],
      },
    },
  ]);
  expect(selected?.href).toBe(work.href);
  expect(selected?.title).toEqual({ value: '新的故事', lang: 'zh-Hant', dir: 'ltr' });
  expect(selected?.kicker?.value).toBe('新作');
  expect(selected?.art?.landscape?.url).toBe(`/api/main${image.url}`);
  expect(selected?.art?.landscape?.candidates).toHaveLength(1);
  expect(selected?.art?.landscape?.alt).toBe('The cover of a new story');
  expect(selected?.art?.landscape?.focal).toEqual({ x: 0.6, y: 0.2, width: 0.2, height: 0.5 });
  expect(presentationSlide(slide, null, context, [])).toBeNull();
  expect(
    presentationSlide({ id: 'link', href: '/about', title: 'Event' }, null, context, [])?.href,
  ).toBe('/about');
  expect(
    liveSlides(
      [
        { id: 'active', startsAt: '2026-10-05T00:00:00.000Z' },
        { id: 'expired', endsAt: '2026-10-05T00:00:00.000Z' },
      ],
      Date.parse('2026-10-05T00:00:00.000Z'),
    ).map((slide) => slide.id),
  ).toEqual(['active']);
});

test('one contextual Work art batch enriches all hero modules and preserves campaign priority and the Work trailer', async () => {
  const campaign = { landscape: { url: '/campaign.webp', width: 1600, height: 900, framed: true } };
  const first = hero([
    { id: 'campaign', href: work.href, title: work.title!, work, art: campaign },
  ]);
  const second = hero([{ id: 'pick', href: work.href, title: work.title!, work }]);
  const calls: { targets: readonly string[]; context: string }[] = [];
  const loaded = await enrichShowcaseModules(
    [first, second],
    { locale: 'en', realm, ref: 'books' },
    async (targets, context) => {
      calls.push({ targets, context });
      return new Map([[target, own]]);
    },
  );
  expect(calls).toEqual([{ targets: [target], context: `https://rezics.com/id/${realm}` }]);
  const read = (placed: PlacedModule) => {
    if (placed.module.type !== 'hero-carousel' || placed.state.state !== 'ready')
      throw new Error('Wrong module');
    return (placed.state.data as { slides: ZoneShowcaseSlide[] }).slides[0]!;
  };
  expect(slideArt(read(loaded[0]!))).toBe(campaign);
  expect(slideArt(read(loaded[1]!))?.landscape?.url).toStartWith(
    '/api/main/v1/media/representations/',
  );
  expect(read(loaded[0]!).trailer?.href).toBe(own.trailer?.url);
  expect(read(first).work?.showcaseArt).toBeUndefined();
});

test('unavailable Work art leaves a cover composition and no trailer; link-only slides need no batch', async () => {
  const source = hero([{ id: 'pick', href: work.href, title: work.title!, work }]);
  const [loaded] = await enrichShowcaseModules(
    [source],
    { locale: 'en', realm, ref: 'books' },
    async () => new Map(),
  );
  expect(loaded).toBe(source);
  let calls = 0;
  await enrichShowcaseModules(
    [hero([{ id: 'event', href: '/event', title: work.title! }])],
    { locale: 'en', realm, ref: 'books' },
    async () => {
      calls++;
      return new Map();
    },
  );
  expect(calls).toBe(0);
  expect(showcaseTargets([target, target])).toEqual([target]);
});

test('delivery adapts Main srcsets, crops and logo keys without duplicate codec widths', () => {
  const adapted = deliveredShowcaseImage(image);
  expect(adapted.candidates).toEqual([{ url: '/api/main/v1/media/small.webp', width: 640 }]);
  expect(adapted.focal).toEqual({ x: 0.6, y: 0.2, width: 0.2, height: 0.5 });
  expect(showcaseFocal('xywh=percent:30,10,20,30', 'xywh=percent:25,0,50,100')?.x).toBeCloseTo(0.1);
  const art = workShowcaseArt({
    ...own,
    images: [{ ...image, role: 'logo', language: 'und', tone: 'light', anchor: 'center-top' }],
  });
  expect(art.logos?.[0]).toMatchObject({ language: '', anchor: 'center-top', tone: 'light' });
});

test('portrait cropping preserves the complete focal rectangle, including near an edge', () => {
  const landscape = { url: '/landscape.webp', width: 1600, height: 900, framed: true };
  expect(focalFrame(landscape, 3 / 4).fit).toBe('contain');
  expect(
    focalFrame({ ...landscape, focal: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 } }, 3 / 4).fit,
  ).toBe('contain');
  expect(
    focalFrame({ ...landscape, focal: { x: 0.9, y: 0.2, width: 0.1, height: 0.5 } }, 3 / 4),
  ).toEqual({ fit: 'cover', position: '100% 50%' });
  expect(
    focalFrame(
      { ...landscape, framed: false, focal: { x: 0.6, y: 0.2, width: 0.1, height: 0.1 } },
      3 / 4,
    ).fit,
  ).toBe('contain');
});
