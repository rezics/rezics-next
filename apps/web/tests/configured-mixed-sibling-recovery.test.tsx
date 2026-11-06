import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { CompositionDocument } from '@rezics/composition';
import home from '../src/kernel/recorded/home-page.json';
import reactions from '../src/kernel/recorded/subject-reactions.json';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { planReads, platformRegistry } = await import('@rezics/composition');
const { dataComponents, PageData } = await import('../src/features/pages/data');
const { layoutComponents, pageDefinitions } = await import('../src/features/pages/layout');
const { CompositionRender } = await import('../src/features/pages/render');

const subject = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const document: CompositionDocument = {
  root: { props: {} },
  content: [
    {
      type: 'TypeList',
      props: {
        id: 'books',
        title: { en: 'Books' },
        types: ['schema:Book'],
        sort: 'collections',
        limit: 12,
      },
    },
    { type: 'Heading', props: { id: 'between', text: { en: 'Kept sibling' }, level: 2 } },
    {
      type: 'TypeList',
      props: {
        id: 'recipes',
        title: { en: 'Recipes' },
        types: ['schema:Recipe'],
        sort: 'collections',
        limit: 12,
      },
    },
    { type: 'ReactionSummary', props: { id: 'reactions' } },
  ],
};

test('unavailable TypeList siblings skip while recorded recipes and public reactions keep document order', () => {
  const plan = planReads(platformRegistry, document, { subject });
  const html = renderToString(
    createElement(
      PageData,
      {
        locale: 'en',
        subject,
        currentHref: '/en/subjects/little-prince/',
        listTarget: { route: '/' },
        document,
        messages: {
          unknown: 'Unknown',
          none: 'None',
          unlabelled: 'Untitled',
          sources: 'Sources',
          aliases: 'Aliases',
          search: 'Search',
        },
        reads: {
          [plan.nodes.books!]: { status: 429, body: {}, retryAt: Date.now() + 60_000 },
          [plan.nodes.recipes!]: { status: 200, body: home.reads.r3.body },
          [plan.nodes.reactions!]: {
            status: 200,
            body: { counts: reactions.counts, watermark: reactions.watermark },
          },
        },
      },
      createElement(CompositionRender, {
        document,
        definitions: pageDefinitions,
        components: { ...layoutComponents, ...dataComponents },
      }),
    ),
  );
  expect(html.indexOf('Books')).toBeGreaterThanOrEqual(0);
  expect(html.indexOf('Books')).toBeLessThan(html.indexOf('Kept sibling'));
  expect(html.indexOf('Kept sibling')).toBeLessThan(html.indexOf('Recipes'));
  expect(html.indexOf('Recipes')).toBeLessThan(html.indexOf('Reactions'));
  expect(html).toContain('disabled');
  expect(html).toContain('Nikujaga');
  expect(html).toContain('Shakshuka');
  expect(html).toContain('Like 42');
  expect(html).not.toContain('Snow Country');
  expect(html).not.toContain('Kokoro');
});
