import { describe, expect, test } from 'bun:test';
import type { WorkCardSlotProps, ZoneContext, ZoneMatchedRelease, ZoneReleaseFilterSpec } from '@rezics/zone-sdk';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type ReleaseHit, type ReleaseRecords, releaseWork } from '../features/release-filter/adapt.ts';
import { ReleaseBrowse } from '../features/release-filter/browse.tsx';
import { ReleaseFilterControl } from '../features/release-filter/control.tsx';
import { noReleaseFilter, parseReleaseFilter, releaseFilterActive, releaseFilterHref, releaseGroup, without }
  from '../features/release-filter/state.ts';
import type { Realization, Release } from '../features/work-levels/types.ts';
import { messages as zoneMessages } from '../features/zones/messages.ts';
import lightNovels from '../zones/official/light-novels/index.tsx';
import visualNovels from '../zones/official/visual-novels/index.tsx';
import { ReleaseLine, VisualNovelCard } from '../zones/official/visual-novels/slots.tsx';
import { localeStrings as lightNovelStrings } from '../zones/official/light-novels/strings.ts';
import { localeStrings as visualNovelStrings } from '../zones/official/visual-novels/strings.ts';

const iri = (name: string) => `https://rezics.com/id/00000000-0000-4000-8000-${name.padStart(12, '0')}`;
const work = iri('1');
const spec = (visualNovels.releaseFilter as (locale: string) => ZoneReleaseFilterSpec)('en');

describe('G-853 release filter state', () => {
  test('the URL names one release group; a value Main would refuse is dropped, not sent', () => {
    expect(parseReleaseFilter({ releaseLanguage: 'en', releasePlatform: 'Windows', releaseCompleteness: 'complete',
      releaseOrigin: 'unofficial', cursor: 'c1' })).toEqual({ language: 'en', platform: 'Windows',
      completeness: 'complete', origin: 'unofficial', cursor: 'c1' });
    expect(parseReleaseFilter({ releaseLanguage: 'English!', releasePlatform: '<script>', releaseCompleteness: 'done',
      releaseOrigin: 'fan', cursor: 'x'.repeat(3000) })).toEqual(noReleaseFilter);
    // A tag outside the interface languages is as valid as `en`.
    expect(parseReleaseFilter({ releaseLanguage: 'th' }).language).toBe('th');
    expect(parseReleaseFilter({ releaseLanguage: ['zh-Hant', 'en'] }).language).toBe('zh-Hant');
  });

  test('with nothing chosen there is no group; the Zone browses as before', () => {
    expect(releaseFilterActive(parseReleaseFilter({ releaseLanguage: '' }))).toBe(false);
    expect(releaseGroup(noReleaseFilter)).toBeNull();
  });

  test('every chosen condition goes into the same group, and withdrawn or virtual releases never answer', () => {
    const group = releaseGroup(parseReleaseFilter({ releaseLanguage: 'en', releasePlatform: 'Windows',
      releaseCompleteness: 'complete' }));
    expect(group).toEqual({ facet: 'release', where: { all: [
      { facet: 'releaseLanguage', any: ['en'] }, { facet: 'releasePlatform', any: ['Windows'] },
      { facet: 'releaseCompleteness', any: ['complete'] },
      { facet: 'releaseStatus', any: ['official', 'unofficial'] }] } });
    expect(releaseGroup(parseReleaseFilter({ releaseLanguage: 'en', releaseOrigin: 'unofficial' }))!.where.all.at(-1))
      .toEqual({ facet: 'releaseStatus', any: ['unofficial'] });
  });

  test('links round-trip, a changed filter starts from the first page and a chip removes one condition', () => {
    const state = parseReleaseFilter({ releaseLanguage: 'en', releasePlatform: 'Switch', cursor: 'next' });
    const href = releaseFilterHref('/r/visual-novels/browse', state);
    expect(parseReleaseFilter(Object.fromEntries(new URL(href, 'https://x').searchParams))).toEqual(state);
    expect(releaseFilterHref('/b', without(state, 'platform'))).toBe('/b?releaseLanguage=en');
    expect(releaseFilterHref('/b', noReleaseFilter)).toBe('/b');
  });
});

describe('G-853 a result says only what Main matched', () => {
  const coverage = (language: string, completeness: Release['coverage'][number]['completeness'], realization: string) =>
    ({ work, mainVersion: iri('9'), language, completeness, realization, revision: null });
  const release = (id: string, overrides: Partial<Release>): Release => ({ id: iri(id), platform: 'Windows',
    status: 'official', contentLanguages: ['en'], coverage: [], ...overrides } as unknown as Release);
  const realization = (id: string, translators: string[]) => ({ id: iri(id), translators } as unknown as Realization);
  const name = (value: string) => ({ value, lang: 'en', dir: 'ltr' as const });
  const records = (): ReleaseRecords => ({
    releases: new Map([
      [iri('10'), release('10', { status: 'unofficial', coverage: [coverage('ja', 'complete', iri('20')),
        coverage('en', 'trial', iri('21')), coverage('en', 'complete', iri('22'))] })],
      // Read, but not named by Main for this Work: it must never reach a card.
      [iri('11'), release('11', { platform: 'Switch', coverage: [coverage('en', 'complete', iri('22'))] })]]),
    realizations: new Map([[iri('22'), realization('22', [iri('30')])], [iri('21'), realization('21', [iri('31')])]]),
    translators: new Map([[iri('30'), name('Translation Club')], [iri('31'), name('Wrong Group')]]) });
  const hit = (matched: string[], more = false): ReleaseHit => ({ id: work,
    title: { value: 'A visual novel', language: 'en', direction: 'ltr', basis: 'requested' } as never,
    cover: null, matchedReleases: matched, moreMatchedReleases: more });
  const context = { locale: 'en' as const, ref: 'visual-novels', realm: iri('5') };

  test('a card carries the releases Main returned for the Work and no other read record', () => {
    const state = parseReleaseFilter({ releaseLanguage: 'en', releaseCompleteness: 'complete' });
    const { matches } = releaseWork(hit([iri('10')]), state, spec, context, records());
    expect(matches.releases.map(item => item.id)).toEqual([iri('10')]);
    expect(matches.more).toBe(false);
  });

  test('the entry that matched is stated: English complete, not the Japanese or the English trial of one release', () => {
    const state = parseReleaseFilter({ releaseLanguage: 'en', releaseCompleteness: 'complete' });
    const [line] = releaseWork(hit([iri('10')]), state, spec, context, records()).matches.releases;
    expect(line).toMatchObject({ language: 'en', completeness: 'complete', origin: 'unofficial', platform: 'Windows' });
    expect(line!.translators.map(item => item.value)).toEqual(['Translation Club']);
  });

  test('a release Main named but whose record could not be read is left out, never guessed', () => {
    const { matches } = releaseWork(hit([iri('10'), iri('99')], true), noReleaseFilter, spec, context, records());
    expect(matches.releases.map(item => item.id)).toEqual([iri('10')]);
    expect(matches.more).toBe(true);
  });

  const zone = { locale: 'en' } as ZoneContext;
  const props = (matches?: WorkCardSlotProps['matches']) => ({ zone, work: {} as never, layout: 'row' as const,
    matches, nextVolume: null, fallback: createElement('div', { id: 'platform-row' }), Link: 'a' as never });

  test('class guard: the Visual Novels card draws a release line only for releases in `matches`', () => {
    const shown: ZoneMatchedRelease[] = [{ id: iri('10'), language: 'en', platform: 'Windows', completeness: 'complete',
      origin: 'unofficial', translators: [{ value: 'Translation Club', lang: 'en', dir: 'ltr' }] }];
    const html = renderToStaticMarkup(createElement(VisualNovelCard, props({ releases: shown, more: false })));
    expect([...html.matchAll(/data-release="([^"]+)"/g)].map(item => item[1])).toEqual([iri('10')]);
    expect(html).toContain('English · Windows · complete · fan translation by <span><bdi lang="en" dir="ltr">Translation Club</bdi></span>');
    // Without matches the card is the platform's row: no release line can appear.
    const plain = renderToStaticMarkup(createElement(VisualNovelCard, props()));
    expect(plain).toContain('platform-row');
    expect(plain).not.toContain('data-release');
    // A package slot never reads a release from the Work itself.
    expect(renderToStaticMarkup(createElement(VisualNovelCard, { ...props(), work: { title: { value: 'English Windows complete' } } as never })))
      .not.toContain('data-release');
  });

  test('official releases and unknown completeness are stated as such; a missing translator is not invented', () => {
    const line = (match: Partial<ZoneMatchedRelease>) => renderToStaticMarkup(createElement(ReleaseLine, { locale: 'en',
      match: { id: iri('1'), language: 'ja', platform: null, completeness: 'unknown', origin: 'official', translators: [],
        ...match } }));
    expect(line({})).toContain('Japanese · completeness unknown · official release');
    expect(line({ origin: 'unofficial' })).toContain('fan translation');
    expect(line({ origin: 'unofficial' })).not.toContain(' by ');
  });
});

describe('G-853 the control and its results', () => {
  const state = parseReleaseFilter({ releaseLanguage: 'en', releasePlatform: 'Windows' });
  const html = (node: ReactNode) => renderToStaticMarkup(node as never);

  test('every field is a labelled native select in a GET form, reachable without script', () => {
    const markup = html(createElement(ReleaseFilterControl, { spec, state, action: '/r/visual-novels/browse',
      clearHref: '/r/visual-novels/browse' }));
    expect(markup).toContain('method="get"');
    expect(markup).toContain('action="/r/visual-novels/browse"');
    for (const name of ['releaseLanguage', 'releasePlatform', 'releaseCompleteness', 'releaseOrigin']) {
      expect(markup).toContain(`name="${name}"`);
    }
    expect(markup.match(/<label /g)).toHaveLength(4);
    expect(markup).toContain('type="submit"');
    expect(markup).toContain('Clear filters');
  });

  test('a value the address names that the Zone does not list stays selected', () => {
    const markup = html(createElement(ReleaseFilterControl, { spec, state: parseReleaseFilter({ releaseLanguage: 'th' }),
      action: '/b', clearHref: '/b' }));
    expect(markup).toMatch(/<option[^>]*value="th"[^>]*>th<\/option>/);
  });

  const card = (work: { title: { value: string } | null }) => createElement('span', null, work.title?.value);
  const browse = (items: { work: never; matches: never }[], next: string | null) => html(createElement(ReleaseBrowse, {
    header: null, spec, state, base: '/r/visual-novels/browse', items, next, card: card as never,
    messages: zoneMessages, locale: 'en' }));

  test('no match says no release meets the filter and offers to clear; it never lists a look-alike', () => {
    const markup = browse([], null);
    expect(markup).toContain(spec.noMatch.title);
    expect(markup).toContain(zoneMessages.clearAll);
    expect(markup).not.toContain('data-release-results');
  });

  test('an empty page Main continues past says to keep looking instead of claiming nothing exists', () => {
    const markup = browse([], 'cursor-2');
    expect(markup).toContain(spec.keepLooking);
    expect(markup).not.toContain(spec.noMatch.title);
    expect(markup).toContain('releaseLanguage=en');
    expect(markup).toContain('cursor=cursor-2');
  });
});

describe('G-853 the packages', () => {
  test('the filter offers only values Main admits for its facets', () => {
    for (const locale of ['en', 'zh-Hant', 'ja']) {
      const filter = (visualNovels.releaseFilter as (locale: string) => ZoneReleaseFilterSpec)(locale);
      for (const option of filter.language.options) expect(option.value).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/);
      for (const option of filter.platform!.options) expect(option.value.length).toBeLessThanOrEqual(120);
      expect(filter.completeness!.options.map(option => option.value)).toEqual(['complete', 'partial', 'trial', 'unknown']);
      expect(filter.origin!.options.map(option => option.value)).toEqual(['official', 'unofficial']);
    }
  });

  test('both Zones link to each other and say what they do not cover, in all eight locales', () => {
    for (const table of [lightNovelStrings, visualNovelStrings]) {
      expect(Object.keys(table).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']);
      for (const strings of Object.values(table)) {
        expect(strings.coverageBody.length).toBeGreaterThan(20);
        expect(strings.attribution).toMatch(/VNDB/);
      }
    }
    expect(lightNovels.slots.footer).toBeDefined();
    expect(visualNovels.slots.footer).toBeDefined();
  });
});
