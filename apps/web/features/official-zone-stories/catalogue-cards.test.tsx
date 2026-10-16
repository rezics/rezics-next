import { direction } from '@rezics/main/language';
import type { ZoneLinkProps } from '@rezics/zone-sdk';
import { expect, test } from 'bun:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnimeBrowseHeader, AnimeCard, AnimeCataloguePanel, AnimeFooter } from '../../zones/official/anime/slots.tsx';
import { MangaBrowseHeader, MangaCard, MangaCataloguePanel, MangaFooter } from '../../zones/official/manga/slots.tsx';
import { installHostZoneAddresses } from '../zones/addresses.ts';
import { ZoneBrowse } from '../zones/browse.tsx';
import type { BrowseModel } from '../zones/browse-view.ts';
import { cataloguePlatformWork, ZoneWorkRow } from '../zones/card.tsx';
import { profileHref } from '../profile/route.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { catalogueFacts, catalogueWork, catalogueZone } from './catalogue-zone.tsx';

const Link = ((props: ZoneLinkProps) => createElement('a', props)) as ComponentType<ZoneLinkProps>;
const draw = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

test.each(['anime', 'manga'] as const)('%s attribution links remain distinguishable without colour', ref => {
  const footer = ref === 'anime' ? AnimeFooter : MangaFooter;
  const html = draw(createElement(footer, { zone: catalogueZone(ref, 'en'), Link, fallback: null,
    credit: { sourceHref: 'https://bgm.tv', licenceHref: 'https://creativecommons.org/licenses/by-sa/3.0/' } }));
  const links = [...html.matchAll(/<a\b[^>]*>/g)].map(match => match[0]);
  for (const href of ['https://bgm.tv', 'https://creativecommons.org/licenses/by-sa/3.0/']) {
    const link = links.find(tag => tag.includes(`href="${href}"`));
    expect(link).toBeDefined();
    expect(link?.match(/class="([^"]*)"/)?.[1]?.split(/\s+/)).toContain('underline');
  }
});

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

test('the source credit is the footer, once, as the visual-novel Zone places its own', () => {
  installHostZoneAddresses();
  const year = { action: '/browse', value: '1980', kept: [], clearHref: null, directoryHref: '/browse?years=1',
    directory: false, window: 0, bounded: false };
  const animeHead = draw(createElement(AnimeBrowseHeader, {
    zone: catalogueZone('anime', 'en'), Link, fallback: null, filter: null, filtered: false, year,
  }));
  const credit = { sourceHref: 'https://bgm.tv', licenceHref: 'https://creativecommons.org/licenses/by-sa/3.0/' };
  const animeFoot = draw(createElement(AnimeFooter, {
    zone: catalogueZone('anime', 'en'), Link, fallback: null, credit,
  }));
  expect(animeHead).not.toContain('Bangumi Archive');
  expect(animeHead).toContain('min-h-11');
  expect(animeHead).toContain('gap-2');
  expect(animeHead).toContain('rounded-xl border border-border/80 bg-card px-4');
  expect(animeFoot).toContain('href="https://bgm.tv"');
  expect(animeFoot).toContain('>Bangumi</a>');
  expect(animeFoot).toContain('href="https://creativecommons.org/licenses/by-sa/3.0/"');
  expect(animeFoot).toContain('>CC BY-SA 3.0</a>');

  const mangaHead = draw(createElement(MangaBrowseHeader, {
    zone: catalogueZone('manga', 'en'), Link, fallback: null, filter: null, filtered: false, year,
  }));
  const mangaFoot = draw(createElement(MangaFooter, {
    zone: catalogueZone('manga', 'en'), Link, fallback: null, credit,
  }));
  expect(mangaHead).not.toContain('Bangumi Archive');
  expect(mangaHead).toContain('min-h-11');
  expect(mangaHead).toContain('gap-2');
  expect(mangaHead).toContain('rounded-xl border border-border/80 bg-card px-4');
  expect(mangaFoot).toContain('href="https://bgm.tv"');
  expect(mangaFoot).toContain('>Bangumi</a>');
  expect(mangaFoot).toContain('href="https://creativecommons.org/licenses/by-sa/3.0/"');
  expect(mangaFoot).toContain('>CC BY-SA 3.0</a>');
});

test('the year control sits in the browse column, in the same row as Filters', () => {
  installHostZoneAddresses();
  const year = { action: '/browse', value: '1980', kept: [], clearHref: '/browse', directoryHref: '/browse?years=1',
    directory: false, window: 0, bounded: false };
  const header = createElement(AnimeBrowseHeader, {
    zone: catalogueZone('anime', 'en'), Link, fallback: null, filter: null, filtered: false, year,
  });
  const model: BrowseModel = {
    title: 'Browse', searchLabel: 'Search Anime', placeholder: 'Search', action: '/browse', kept: [],
    state: { text: null, sort: null, view: 'list', filter: {}, cursor: null },
    groups: [{ facet: 'status', label: 'Status', values: [] }],
    chosen: [], filtersLabel: 'Filters', clearHref: null,
    sorts: [{ sort: 'newest', label: 'Newest', href: '/browse', current: true }],
    views: [
      { view: 'list', label: 'List', href: '/browse', current: true },
      { view: 'grid', label: 'Grid', href: '/browse?view=grid', current: false },
    ],
    results: '1 result', notes: [], items: [], next: null, first: null,
  };
  const html = draw(createElement(ZoneBrowse, {
    model, messages: zoneMessagesFor('en'), card: () => null, header,
  }));
  const page = html.indexOf('px-4');
  const yearAt = html.indexOf('data-catalogue-year');
  const filtersAt = html.indexOf('<details');
  expect(page).toBeGreaterThanOrEqual(0);
  expect(yearAt).toBeGreaterThan(page);
  expect(filtersAt).toBeGreaterThan(yearAt);
  const yearRow = html.slice(yearAt, yearAt + 400);
  const filtersRow = html.slice(filtersAt, filtersAt + 400);
  expect(yearRow).toContain('min-h-11');
  expect(yearRow).toContain('gap-2');
  expect(yearRow).toContain('rounded-xl border border-border/80 bg-card px-4');
  expect(filtersRow).toContain('rounded-xl border border-border/80 bg-card');
  expect(filtersRow).toContain('h-11');
  expect(filtersRow).toContain('gap-2');
  expect(filtersRow).toContain('px-4');
});

test('a catalogue card does not name the account that created the Work', () => {
  const work = catalogueWork('long', 'Long series', 'ja', 'completed');
  work.author = { value: 'catalogue-editor', lang: 'en', dir: direction('en', 'catalogue-editor') };
  work.authorHref = profileHref('catalogue-editor');
  const row = createElement(ZoneWorkRow, {
    work: cataloguePlatformWork(work), locale: 'en', messages: zoneMessagesFor('en'), whyHere: false,
  });
  const card = draw(createElement(AnimeCard, {
    zone: catalogueZone('anime', 'en'), Link, layout: 'row', nextVolume: null, fallback: row,
    work, facts: catalogueFacts('TV', [1980], 1155),
  }));
  const panel = draw(createElement(AnimeCataloguePanel, {
    zone: catalogueZone('anime', 'en'), Link, fallback: null, credits: null,
    work, facts: catalogueFacts('TV', [1980], 1155),
  }));
  expect(card).not.toContain('catalogue-editor');
  expect(card).toContain('1,155 episodes');
  expect(panel).not.toContain('catalogue-editor');
});

test('a catalogue card states status on the fact line, without the platform chip', () => {
  const work = catalogueWork('long', 'Long series', 'ja', 'completed');
  const row = createElement(ZoneWorkRow, {
    work: cataloguePlatformWork(work), locale: 'en', messages: zoneMessagesFor('en'), whyHere: false,
  });
  const card = draw(createElement(AnimeCard, {
    zone: catalogueZone('anime', 'en'), Link, layout: 'row', nextVolume: null, fallback: row,
    work, facts: catalogueFacts('TV', [1980], 1155),
  }));
  expect(card.match(/Completed/g)).toEqual(['Completed']);
  expect(card).toContain('data-catalogue-fact="status"');
  expect(card).not.toContain('rounded-full');
});

test('a reviewed property name labels the count, and the counted phrase stays the package\'s', () => {
  const anime = draw(createElement(AnimeCataloguePanel, {
    zone: catalogueZone('anime', 'en'), Link, fallback: null, credits: null,
    work: catalogueWork('long', 'Long', 'en', 'completed'),
    facts: catalogueFacts('TV', [1980], 1155, false, { value: 'Instalments', lang: 'en', dir: direction('en', 'Instalments') }),
  }));
  expect(anime).toContain('lang="en" dir="ltr">Instalments');
  expect(anime).toContain('1,155 episodes');
  expect(anime).not.toContain('>Episodes<');

  const manga = draw(createElement(MangaCataloguePanel, {
    zone: catalogueZone('manga', 'en'), Link, fallback: null, credits: null,
    work: catalogueWork('long', 'Long', 'en', 'completed'),
    facts: catalogueFacts('Manga', [1995], 21, false, { value: 'Bande', lang: 'de', dir: direction('de', 'Bande') }),
  }));
  expect(manga).toContain('lang="de" dir="ltr">Bande');
  expect(manga).toContain('21 volumes');
  expect(manga).not.toContain('>Volumes<');
});
