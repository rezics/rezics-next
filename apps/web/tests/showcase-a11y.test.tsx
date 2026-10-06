import { expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ZoneShowcaseSlide } from '@rezics/zone-sdk';
import { Showcase } from '../features/showcase/showcase.tsx';
import { messages } from '../features/zones/messages.ts';

const t = materializeData(messages, { locale: 'en' });
const text = (value: string) => ({ value, lang: 'en', dir: 'ltr' as const });
const slide = (id: string, title: string): ZoneShowcaseSlide => ({
  id,
  href: `/${id}`,
  title: text(title),
});

function labels(slides: ZoneShowcaseSlide[]) {
  const html = renderToStaticMarkup(
    <Showcase slides={slides} label="Featured" locale="en" messages={messages} />,
  );
  return {
    indicators: [...html.matchAll(/data-part="indicator"[^>]*aria-label="([^"]*)"/g)].map(
      (match) => match[1],
    ),
    groups: [...html.matchAll(/aria-roledescription="slide"[^>]*aria-label="([^"]*)"/g)].map(
      (match) => match[1],
    ),
  };
}

test('an indicator names its slide, and a slide group only announces its position', () => {
  const { indicators, groups } = labels([slide('a', 'Astral Tide'), slide('b', ''), slide('c', '')]);
  const places = [1, 2, 3].map((index) => t.slide({ index: String(index), count: '3' }));
  expect(groups).toEqual(places);
  expect(indicators).toEqual([
    `Astral Tide · ${places[0]}`,
    `${messages.untitled} · ${places[1]}`,
    `${messages.untitled} · ${places[2]}`,
  ]);
});

test('a slide is named once: by its heading, not by its group, its logo or its art', () => {
  const art = {
    landscape: { url: '/hero.webp', width: 1600, height: 900, framed: true, alt: 'A tide under stars' },
    logos: [{ url: '/logo.webp', width: 600, height: 200, tone: 'light' as const, anchor: 'center-top' as const,
      language: '', alt: 'Astral Tide' }],
  };
  const html = renderToStaticMarkup(
    <Showcase slides={[{ ...slide('a', 'Astral Tide'), art }, slide('b', 'Other')]} label="Featured" locale="en"
      messages={messages} />,
  );
  const first = html.slice(html.indexOf('aria-roledescription="slide"'), html.indexOf('aria-roledescription="slide"', 1 + html.indexOf('aria-roledescription="slide"')));
  expect(first.match(/Astral Tide/g)).toHaveLength(1);
  expect(first.match(/<h2[^>]*>.*?<\/h2>/)?.[0]).toContain('Astral Tide');
  // The authored description is exposed once; the ambient copy and the logo stay decorative.
  expect(first.match(/alt="A tide under stars"/g)).toHaveLength(1);
  expect(first).not.toContain('alt="Astral Tide"');
  expect(first.match(/<img[^>]*src="\/logo\.webp"[^>]*>/)?.[0]).toContain('alt=""');
});
