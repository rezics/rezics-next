import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Carousel, CarouselContent, CarouselItem } from '@rezics/ui/carousel';
import type { ZoneShowcaseArt, ZoneShowcaseSlide } from '@rezics/zone-sdk';
import {
  focalPosition,
  imageSet,
  logoFor,
  pictureSources,
  slideArt,
  stageWindows,
  trailerEmbed,
} from '../features/showcase/stage.ts';

const image = { url: '/landscape.webp', width: 1600, height: 900, framed: true };
const art: ZoneShowcaseArt = {
  landscape: image,
  portrait: { ...image, url: '/portrait.webp', width: 750, height: 1000 },
};
const title = { value: 'Astral Tide', lang: 'en', dir: 'ltr' as const };
test('server HTML exposes the selected slide and makes every hidden slide inert', () => {
  const html = renderToStaticMarkup(
    <Carousel slideCount={3} defaultPage={0}>
      <CarouselContent>
        {[0, 1, 2].map((index) => (
          <CarouselItem key={index} index={index}>
            <a href={`/work/${index}`}>Work {index}</a>
          </CarouselItem>
        ))}
      </CarouselContent>
    </Carousel>,
  );
  const items = html.match(/<div[^>]*data-slot="carousel-item"[^>]*>/g)!;
  expect(items).toHaveLength(3);
  expect(items[0]).toContain('aria-hidden="false"');
  expect(items[0]).not.toContain('inert');
  expect(
    items
      .slice(1)
      .every((item) => item.includes('aria-hidden="true"') && item.includes('inert=""')),
  ).toBe(true);
});
test('picture and preload media come from the same window shapes; portrait falls back to landscape', () => {
  expect(pictureSources(art).map((source) => source.media)).toEqual(
    stageWindows.map((window) => window.media),
  );
  expect(pictureSources(art).map((source) => source.image.url)).toEqual([
    '/portrait.webp',
    '/landscape.webp',
  ]);
  expect(pictureSources({ landscape: image }).map((source) => source.image.url)).toEqual([
    image.url,
    image.url,
  ]);
  expect(
    imageSet({
      ...image,
      candidates: [
        { url: '/small.webp', width: 800 },
        { url: image.url, width: 1600 },
      ],
    }),
  ).toBe('/small.webp 800w, /landscape.webp 1600w');
});
test('logos match the reader language or a language-neutral alternative and the requested tone', () => {
  const logos: ZoneShowcaseArt = {
    logos: [
      { ...image, language: 'ja', tone: 'light', anchor: 'start-bottom' },
      { ...image, language: '', tone: 'dark', anchor: 'center-top' },
    ],
  };
  expect(logoFor(logos, 'en')).toBeNull();
  expect(logoFor(logos, 'ja')?.language).toBe('ja');
  expect(logoFor(logos, 'en', 'dark')?.language).toBe('');
});
test('focal positions use the bounded centre', () => {
  expect(focalPosition({ ...image, focal: { x: 0.5, y: 0.3, width: 0.2, height: 0.4 } })).toBe(
    '60% 50%',
  );
});
test('a slide uses its art before Work-owned art', () => {
  const slide = {
    id: 'work',
    href: '/work',
    title,
    work: { showcaseArt: art },
  } as ZoneShowcaseSlide;
  expect(slideArt(slide)).toBe(art);
  expect(slideArt({ ...slide, art: { landscape: image } })).toEqual({ landscape: image });
});
test('only recognized HTTPS video links become privacy-enhanced, non-autoplay embeds', () => {
  expect(trailerEmbed('https://youtu.be/aqz-KE-bpKQ')).toBe(
    'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?rel=0',
  );
  expect(trailerEmbed('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(
    'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0',
  );
  for (const href of [
    'javascript:alert(1)',
    'http://youtu.be/aqz-KE-bpKQ',
    'https://youtube.com.attacker.test/watch?v=aqz-KE-bpKQ',
    'https://www.youtube.com/watch?v=invalid',
    '/local-video',
    'https://vimeo.com/1',
    'https://youtu.be/aqz-KE-bpKQ?t=90',
    'https://www.bilibili.com/video/BV1xx411c7mD/?p=2',
  ])
    expect(trailerEmbed(href)).toBeNull();
});

test('an explicit RTL track also gives Ark items the RTL direction; artwork can keep its own fit', () => {
  const html = renderToStaticMarkup(
    <Carousel slideCount={1} dir="rtl">
      <CarouselContent>
        <CarouselItem index={0} coverImages={false}>
          <img src="/art.webp" alt="Art" />
        </CarouselItem>
      </CarouselContent>
    </Carousel>,
  );
  const item = html.match(/<div[^>]*data-slot="carousel-item"[^>]*>/)![0];
  expect(item).toContain('dir="rtl"');
  expect(item).not.toContain('object-cover');
});
