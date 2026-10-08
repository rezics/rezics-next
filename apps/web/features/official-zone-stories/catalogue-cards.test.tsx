import type { ZoneLinkProps } from '@rezics/zone-sdk';
import { expect, test } from 'bun:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnimeCard, AnimeCataloguePanel } from '../../zones/official/anime/slots.tsx';
import { MangaCard, MangaCataloguePanel } from '../../zones/official/manga/slots.tsx';
import { catalogueFacts, catalogueWork, catalogueZone } from './catalogue-zone.tsx';

const Link = ((props: ZoneLinkProps) => createElement('a', props)) as ComponentType<ZoneLinkProps>;
const draw = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

test('an anime card keeps recorded facts and leaves unrecorded ones off the grid', () => {
  const zone = catalogueZone('anime', 'en');
  const partial = draw(createElement(AnimeCard, {
    zone, Link, layout: 'cover', nextVolume: null, fallback: null,
    work: catalogueWork('soon', 'Soon', 'en', 'upcoming'),
    facts: catalogueFacts('TV', [], 12),
  }));
  expect(partial).toContain('TV');
  expect(partial).toContain('12 episodes');
  expect(partial).toContain('Upcoming');
  expect(partial).not.toContain('Year not recorded');
  expect(partial).not.toContain('data-catalogue-fact="year"');

  const blank = draw(createElement(AnimeCard, {
    zone, Link, layout: 'cover', nextVolume: null, fallback: null,
    work: catalogueWork('quiet', 'Unclassified picture', 'en', null),
    facts: catalogueFacts(null, [], null),
  }));
  expect(blank).not.toContain('not recorded');
  expect(blank).not.toContain('data-catalogue-facts');

  const failed = draw(createElement(AnimeCard, {
    zone, Link, layout: 'cover', nextVolume: null, fallback: null,
    work: catalogueWork('quiet', 'Unclassified picture', 'en', null),
    facts: catalogueFacts(null, [], null, true),
  }));
  expect(failed).toContain('These catalogue facts are not available right now.');
});

test('an anime work page still names each fact that was not recorded', () => {
  const html = draw(createElement(AnimeCataloguePanel, {
    zone: catalogueZone('anime', 'en'), Link, fallback: null, credits: null,
    work: catalogueWork('quiet', 'Unclassified picture', 'en', null),
    facts: catalogueFacts(null, [], null),
  }));
  expect(html).toContain('Format not recorded');
  expect(html).toContain('Year not recorded');
  expect(html).toContain('Episode count not recorded');
  expect(html).toContain('Status not recorded');
});

test('a manga card keeps recorded facts and leaves unrecorded ones off the grid', () => {
  const zone = catalogueZone('manga', 'en');
  const partial = draw(createElement(MangaCard, {
    zone, Link, layout: 'cover', nextVolume: null, fallback: null,
    work: catalogueWork('one', 'A single chapter', 'en', 'upcoming'),
    facts: catalogueFacts('One-shot', [], null),
  }));
  expect(partial).toContain('One-shot');
  expect(partial).toContain('Upcoming');
  expect(partial).not.toContain('Year not recorded');
  expect(partial).not.toContain('Volume count not recorded');

  const blank = draw(createElement(MangaCard, {
    zone, Link, layout: 'cover', nextVolume: null, fallback: null,
    work: catalogueWork('quiet', 'Unclassified book', 'en', null),
    facts: catalogueFacts(null, [], null),
  }));
  expect(blank).not.toContain('not recorded');
  expect(blank).not.toContain('data-catalogue-facts');
});

test('a manga work page still names each fact that was not recorded', () => {
  const html = draw(createElement(MangaCataloguePanel, {
    zone: catalogueZone('manga', 'en'), Link, fallback: null, credits: null,
    work: catalogueWork('quiet', 'Unclassified book', 'en', null),
    facts: catalogueFacts(null, [], null),
  }));
  expect(html).toContain('Format not recorded');
  expect(html).toContain('Year not recorded');
  expect(html).toContain('Volume count not recorded');
  expect(html).toContain('Status not recorded');
});
