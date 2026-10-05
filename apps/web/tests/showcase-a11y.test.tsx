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

test('every slide indicator and slide group falls back to the untitled label', () => {
  const { indicators, groups } = labels([slide('a', 'Astral Tide'), slide('b', ''), slide('c', '')]);
  const expected = [
    `Astral Tide · ${t.slide({ index: '1', count: '3' })}`,
    `${messages.untitled} · ${t.slide({ index: '2', count: '3' })}`,
    `${messages.untitled} · ${t.slide({ index: '3', count: '3' })}`,
  ];
  expect(groups).toEqual(expected);
  expect(indicators).toEqual(expected);
});
