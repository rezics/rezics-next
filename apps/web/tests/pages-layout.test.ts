import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { layoutComponents, pageDefinitions, PageRoot } from '../src/features/pages/layout.tsx';
import { CompositionRender } from '../src/features/pages/render.tsx';

const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const render = (document: unknown) =>
  renderToString(
    createElement(CompositionRender, {
      document,
      definitions: pageDefinitions,
      components: layoutComponents,
      root: PageRoot,
    } as never),
  );

test('the page definitions come from the platform registry', () => {
  const slots = Object.fromEntries(pageDefinitions.map((definition) => [definition.type, definition.slots]));
  expect(slots).toMatchObject({
    Stack: ['children'],
    Columns: ['start', 'end'],
    Heading: [],
    Text: [],
    Slot: ['children'],
  });
  for (const type of ['Stack', 'Columns', 'Heading', 'Text', 'Slot']) expect(layoutComponents[type]).toBeDefined();
});

test('a layout page renders landmarks, headings and text with the appearance tokens', () => {
  const html = render({
    root: { props: { appearance: { density: 'compact', surface: 'cards', headingScale: 'lg' } } },
    content: [
      node('Slot', 'top', { name: 'header', children: [node('Heading', 'title', { text: 'Kokoro', level: 2 })] }),
      node('Columns', 'body', {
        split: 'start',
        start: [node('Text', 'intro', { text: 'Line one\nLine two\n\nSecond paragraph' })],
        end: [
          node('Slot', 'side', { name: 'aside', children: [node('Heading', 'facts', { text: 'Facts', level: 3 })] }),
        ],
      }),
      node('Stack', 'more', {
        gap: 'lg',
        children: [
          node('Heading', 'note', { text: '3 < 4 & <b>', level: 4 }),
          node('Slot', 'end', { name: 'footer', children: [] }),
        ],
      }),
      node('Slot', 'cover', { name: 'hero', children: [] }),
      node('Slot', 'main', { name: 'entity', children: [] }),
    ],
  });
  expect(html).toMatch(/data-density="compact"/);
  expect(html).toMatch(/data-surface="cards"/);
  expect(html).toMatch(/data-heading-scale="lg"/);
  expect(html).not.toMatch(/data-radius=/);
  expect(html).toMatch(/<header[^>]*>.*<h2[^>]*>Kokoro<\/h2>.*<\/header>/s);
  expect(html).toMatch(/<aside[^>]*>.*<h3[^>]*>Facts<\/h3>.*<\/aside>/s);
  expect(html).toMatch(/<h4[^>]*>3 &lt; 4 &amp; &lt;b&gt;<\/h4>/);
  expect(html).toMatch(/Line one<br\/>Line two/);
  expect(html).toMatch(/<p[^>]*>Second paragraph<\/p>/);
  expect(html).toMatch(/<footer/);
  expect(html).toMatch(/<section[^>]*data-slot="hero"/);
  expect(html).toMatch(/<article/);
  expect(html.indexOf('Kokoro')).toBeLessThan(html.indexOf('Line one'));
  expect(html.indexOf('Line one')).toBeLessThan(html.indexOf('Facts'));
});

test('unknown tokens, slot names and levels fall back instead of reaching the markup', () => {
  const html = render({
    root: { props: { appearance: { density: 'x" onload="alert(1)', radius: 'lg', cover: 'portrait' } } },
    content: [
      node('Heading', 'title', { text: 'Title', level: 9, onclick: 'alert(1)' }),
      node('Slot', 'odd', { name: 'banner', children: [node('Text', 'inside', { text: 'Inside' })] }),
      node('Carousel', 'gone', { text: 'Hidden' }),
    ],
  });
  expect(html).not.toMatch(/data-density=/);
  expect(html).toMatch(/data-radius="lg"/);
  expect(html).toMatch(/data-cover="portrait"/);
  expect(html).toMatch(/<h2[^>]*>Title<\/h2>/);
  expect(html).not.toContain('onclick');
  expect(html).not.toContain('alert(1)');
  expect(html).toMatch(/<div[^>]*>(?:<[^>]+>)*Inside/);
  expect(html).not.toContain('banner');
  expect(html).not.toContain('Hidden');
});
