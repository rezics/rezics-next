import { describe, expect, test } from 'bun:test';
import type { WorkCardSlotProps, ZoneContext, ZoneMatchedRelease, ZoneReleaseFilterSpec } from '@rezics/zone-sdk';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { facetRegistry } from '../../../packages/model/src/generated/facets.ts';
import { type ReleaseHit, type ReleaseRecords, releaseWork } from '../features/release-filter/adapt.ts';
import { ReleaseBrowse } from '../features/release-filter/browse.tsx';
import { ReleaseFilterControl } from '../features/release-filter/control.tsx';
import { closedValues, resolveReleaseFilter, type ResolvedReleaseFilter, type ServedFacet }
  from '../features/release-filter/registry.ts';
import { noReleaseFilter, parseReleaseFilter, releaseFilterActive, releaseFilterHref, releaseGroup, without }
  from '../features/release-filter/state.ts';
import { workLink, zoneWork } from '../features/realm/adapt.ts';
import { replyHref, summaryWork } from '../features/realm/modules.ts';
import type { TrackingApi } from '../features/tracking/api.ts';
import { drawOrder, hubPlan, hubSections } from '../features/work-page/hub.ts';
import type { Realization, Release } from '../features/work-levels/types.ts';
import { MAX_READS, readingOf } from '../features/zones/next-volume.tsx';
import { messages as zoneMessages } from '../features/zones/messages.ts';
import lightNovels from '../zones/official/light-novels/index.tsx';
import visualNovels from '../zones/official/visual-novels/index.tsx';
import { ReleaseLine, VisualNovelCard } from '../zones/official/visual-novels/slots.tsx';
import { localeStrings as lightNovelStrings } from '../zones/official/light-novels/strings.ts';
import { localeStrings as visualNovelStrings } from '../zones/official/visual-novels/strings.ts';

const iri = (name: string) => `https://rezics.com/id/00000000-0000-4000-8000-${name.padStart(12, '0')}`;
const work = iri('1');
const spec = (visualNovels.releaseFilter as (locale: string) => ZoneReleaseFilterSpec)('en');
/** The registry as Main serves it at `GET /v1/facets`: the generated one, whole. */
const served = Object.values(facetRegistry) as unknown as ServedFacet[];
const filter = resolveReleaseFilter(spec, served, 'en') as ResolvedReleaseFilter;
const parse = (params: Record<string, string | string[]>) => parseReleaseFilter(params, filter);
const patternOf = (name: string) => (Object.values(facetRegistry).find(facet => facet.name === name)!
  .values as readonly { kind: string; pattern?: string }[]).find(value => value.kind === 'datatype')!.pattern!;

describe('G-853 the release filter comes from the served registry', () => {
  test('its fields are the registry\'s release facets, inside the registry\'s release group', () => {
    expect(filter.group).toBe('release');
    expect(filter.fields.map(field => field.facet)).toEqual(['releaseLanguage', 'releasePlatform',
      'releaseCompleteness', 'releaseStatus']);
    for (const field of filter.fields) expect(field.pattern.source).toBe(new RegExp(patternOf(field.facet)).source);
  });

  test('closed sets are the registry\'s, and the Zone offers only members of them', () => {
    const field = (name: string) => filter.fields.find(item => item.facet === name)!;
    expect(field('releaseCompleteness').closed).toEqual(closedValues(patternOf('releaseCompleteness')));
    expect(field('releaseCompleteness').closed).toEqual(['complete', 'partial', 'trial', 'unknown']);
    expect(field('releaseCompleteness').options.map(option => option.value)).toEqual(['complete', 'partial', 'trial', 'unknown']);
    // Official and unofficial are members of the status set; withdrawn, cancelled and virtual are not offered.
    expect(field('releaseStatus').closed).toContain('withdrawn');
    expect(field('releaseStatus').options.map(option => option.value)).toEqual(['official', 'unofficial']);
    expect(field('releaseStatus').unchosen).toEqual(['official', 'unofficial']);
    // Language and platform are open: the Zone's lists are suggestions.
    expect(field('releaseLanguage').closed).toBeNull();
    expect(field('releasePlatform').closed).toBeNull();
  });

  test('a suggestion or default the registry would refuse is dropped, never offered', () => {
    const odd = resolveReleaseFilter({ fields: [{ facet: 'releaseStatus', any: 'any', unchosen: ['official', 'bogus'],
      options: [{ value: 'official', label: 'Official' }, { value: 'bogus', label: 'Bogus' }] }] }, served, 'en')!;
    expect(odd.fields[0]!.options.map(option => option.value)).toEqual(['official']);
    expect(odd.fields[0]!.unchosen).toEqual(['official']);
  });

  test('a facet the registry does not serve as current, or inside another group, is not a field', () => {
    const only = (name: string, current = true) => served.map(facet => facet.name === name ? { ...facet, current } : facet);
    expect(resolveReleaseFilter(spec, only('releasePlatform', false), 'en')!.fields.map(field => field.facet))
      .not.toContain('releasePlatform');
    expect(resolveReleaseFilter({ fields: [{ facet: 'releaseLanguage', any: 'x' }, { facet: 'author', any: 'y' }] },
      served, 'en')!.fields.map(field => field.facet)).toEqual(['releaseLanguage']);
    expect(resolveReleaseFilter({ fields: [{ facet: 'noSuchFacet', any: 'x' }] }, served, 'en')).toBeNull();
    // Without the release group itself there is nothing to put the conditions in.
    expect(resolveReleaseFilter(spec, served.filter(facet => facet.name !== 'release'), 'en')).toBeNull();
  });

  test('a facet added to the registry needs no web change: the territory facet is a field when the Zone names it', () => {
    const territory = resolveReleaseFilter({ fields: [{ facet: 'releaseTerritory', any: 'Anywhere' }] }, served, 'en')!;
    expect(territory.fields[0]!.facet).toBe('releaseTerritory');
    expect(territory.fields[0]!.label).toBe(Object.values(facetRegistry).find(facet => facet.name === 'releaseTerritory')!.labels.en);
  });

  test('a field without the Zone\'s word takes the registry\'s label in the reader\'s language', () => {
    const ja = resolveReleaseFilter({ fields: [{ facet: 'releaseLanguage', any: '—' }] }, served, 'ja')!;
    expect(ja.fields[0]!.label).toBe(Object.values(facetRegistry).find(facet => facet.name === 'releaseLanguage')!.labels.ja);
  });
});

describe('G-853 release filter state', () => {
  test('the URL names each choice by its facet; a value the registry would refuse is dropped, not sent', () => {
    expect(parse({ releaseLanguage: 'en', releasePlatform: 'Windows', releaseCompleteness: 'complete',
      releaseStatus: 'unofficial', cursor: 'c1' })).toEqual({ conditions: { releaseLanguage: 'en',
      releasePlatform: 'Windows', releaseCompleteness: 'complete', releaseStatus: 'unofficial' }, cursor: 'c1' });
    expect(parse({ releaseLanguage: 'English!', releaseCompleteness: 'done', releaseStatus: 'withdrawn-ish',
      cursor: 'x'.repeat(3000) })).toEqual(noReleaseFilter);
    // The registry's platform pattern is `^.{1,120}$`: a platform the old narrow copy refused is valid.
    expect(parse({ releasePlatform: 'PlayStation 4 (Pro) / Slim' }).conditions.releasePlatform).toBe('PlayStation 4 (Pro) / Slim');
    expect(parse({ releasePlatform: 'x'.repeat(121) }).conditions.releasePlatform).toBeUndefined();
    // A tag outside the interface languages is as valid as `en`.
    expect(parse({ releaseLanguage: 'th' }).conditions.releaseLanguage).toBe('th');
    expect(parse({ releaseLanguage: ['zh-Hant', 'en'] }).conditions.releaseLanguage).toBe('zh-Hant');
    // A closed set admits every member of the registry's set, offered or not.
    expect(parse({ releaseStatus: 'withdrawn' }).conditions.releaseStatus).toBe('withdrawn');
  });

  test('with nothing chosen there is no group; the Zone browses as before', () => {
    expect(releaseFilterActive(parse({ releaseLanguage: '' }))).toBe(false);
    expect(releaseGroup(noReleaseFilter, filter)).toBeNull();
  });

  test('every chosen condition goes into the same group, and the Zone\'s unchosen defaults fill the rest', () => {
    const group = releaseGroup(parse({ releaseLanguage: 'en', releasePlatform: 'Windows', releaseCompleteness: 'complete' }),
      filter);
    expect(group).toEqual({ facet: 'release', where: { all: [
      { facet: 'releaseLanguage', any: ['en'] }, { facet: 'releasePlatform', any: ['Windows'] },
      { facet: 'releaseCompleteness', any: ['complete'] },
      { facet: 'releaseStatus', any: ['official', 'unofficial'] }] } });
    expect(releaseGroup(parse({ releaseLanguage: 'en', releaseStatus: 'unofficial' }), filter)!.where.all.at(-1))
      .toEqual({ facet: 'releaseStatus', any: ['unofficial'] });
  });

  test('links round-trip, a changed filter starts from the first page and a chip removes one condition', () => {
    const state = parse({ releaseLanguage: 'en', releasePlatform: 'Switch', cursor: 'next' });
    const href = releaseFilterHref('/r/visual-novels/browse', state);
    expect(parse(Object.fromEntries(new URL(href, 'https://x').searchParams))).toEqual(state);
    expect(releaseFilterHref('/b', without(state, 'releasePlatform'))).toBe('/b?releaseLanguage=en');
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
    const state = parse({ releaseLanguage: 'en', releaseCompleteness: 'complete' });
    const { matches } = releaseWork(hit([iri('10')]), state, spec, context, records());
    expect(matches.releases.map(item => item.id)).toEqual([iri('10')]);
    expect(matches.more).toBe(false);
  });

  test('the entry that matched is stated: English complete, not the Japanese or the English trial of one release', () => {
    const state = parse({ releaseLanguage: 'en', releaseCompleteness: 'complete' });
    const [line] = releaseWork(hit([iri('10')]), state, spec, context, records()).matches.releases;
    expect(line).toMatchObject({ language: 'en', completeness: 'complete', origin: 'unofficial', platform: 'Windows' });
    expect(line!.translators.map(item => item.value)).toEqual(['Translation Club']);
  });

  test('a v2 release whose language and completeness sit on different entries is still stated as the filter chose', () => {
    // Main compares v2 records at release level: Japanese complete + English trial matches "English + complete".
    const split = new Map([[iri('12'), release('12', { coverage: [coverage('ja', 'complete', iri('20')),
      coverage('en', 'trial', iri('21'))] })]]);
    const state = parse({ releaseLanguage: 'en', releaseCompleteness: 'complete' });
    const [line] = releaseWork(hit([iri('12')]), state, spec, context, { ...records(), releases: split })
      .matches.releases;
    expect(line).toMatchObject({ language: 'en', completeness: 'complete', platform: 'Windows' });
    // The translator is the one of the English entry, never of the Japanese one.
    expect(line!.translators.map(item => item.value)).toEqual(['Wrong Group']);
  });

  test('a legacy release with no entry in the chosen language names the language and invents no translator', () => {
    const legacy = new Map([[iri('13'), release('13', { contentLanguages: ['en', 'th'],
      coverage: [coverage('ja', 'unknown', iri('20'))] })]]);
    const state = parse({ releaseLanguage: 'th' });
    const [line] = releaseWork(hit([iri('13')]), state, spec, context, { ...records(), releases: legacy }).matches.releases;
    expect(line).toMatchObject({ language: 'th', completeness: 'unknown', translators: [] });
  });

  test('conditions the reader did not choose come from the release and its entry', () => {
    const [line] = releaseWork(hit([iri('10')]), parse({ releaseStatus: 'unofficial' }), spec, context, records())
      .matches.releases;
    expect(line).toMatchObject({ origin: 'unofficial', platform: 'Windows' });
  });

  test('a release Main named but whose record could not be read is left out, never guessed', () => {
    const { matches } = releaseWork(hit([iri('10'), iri('99')], true), parse({ releaseLanguage: 'en' }), spec, context, records());
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
    expect(html).toContain('English · Windows · complete · fan translation by <bdi lang="en" dir="ltr">Translation Club</bdi>');
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

  test('several translators read as a list in the reader\'s language, each in its own direction', () => {
    const names = [{ value: 'A', lang: 'en', dir: 'ltr' as const }, { value: 'B', lang: 'en', dir: 'ltr' as const },
      { value: 'مجموعة', lang: 'ar', dir: 'rtl' as const }];
    const html = (locale: string) => renderToStaticMarkup(createElement(ReleaseLine, { locale, match: { id: iri('1'),
      language: 'en', platform: null, completeness: 'complete', origin: 'unofficial', translators: names } }));
    expect(html('en')).toContain('<bdi lang="en" dir="ltr">A</bdi><span>, </span><bdi lang="en" dir="ltr">B</bdi><span>, and </span><bdi lang="ar" dir="rtl">مجموعة</bdi>');
    expect(html('ja')).toContain('<bdi lang="en" dir="ltr">A</bdi><span>、</span>');
  });
});

describe('G-853 the control and its results', () => {
  const state = parse({ releaseLanguage: 'en', releasePlatform: 'Windows' });
  const html = (node: ReactNode) => renderToStaticMarkup(node as never);

  test('every field is a labelled select with a real form field in a GET form, reachable without script', () => {
    const markup = html(createElement(ReleaseFilterControl, { spec, filter, state, action: '/r/visual-novels/browse',
      clearHref: '/r/visual-novels/browse' }));
    expect(markup).toContain('method="get"');
    expect(markup).toContain('action="/r/visual-novels/browse"');
    for (const name of ['releaseLanguage', 'releasePlatform', 'releaseCompleteness', 'releaseStatus']) {
      expect(markup).toContain(`name="${name}"`);
    }
    expect(markup.match(/<label /g)).toHaveLength(4);
    expect(markup).toContain('type="submit"');
    expect(markup).toContain('Clear filters');
  });

  test('a value the address names that the Zone does not list stays selected', () => {
    const markup = html(createElement(ReleaseFilterControl, { spec, filter, state: parse({ releaseLanguage: 'th' }),
      action: '/b', clearHref: '/b' }));
    expect(markup).toMatch(/<option[^>]*value="th"[^>]*>th<\/option>/);
  });

  const card = (work: { title: { value: string } | null }) => createElement('span', null, work.title?.value);
  const browse = (items: { work: never; matches: never }[], next: string | null) => html(createElement(ReleaseBrowse, {
    header: null, spec, filter, state, base: '/r/visual-novels/browse', items, next, card: card as never,
    messages: zoneMessages, locale: 'en', firstPage: 'Back to the first page' }));

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
  test('a Zone\'s suggestions all pass the registry\'s patterns, in every locale', () => {
    for (const locale of ['en', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'zh-Hans']) {
      const zoneSpec = (visualNovels.releaseFilter as (locale: string) => ZoneReleaseFilterSpec)(locale);
      const resolved = resolveReleaseFilter(zoneSpec, served, locale)!;
      for (const field of zoneSpec.fields) {
        const offered = resolved.fields.find(item => item.facet === field.facet)!;
        expect(offered.options, `${locale} ${field.facet}`).toHaveLength(field.options?.length ?? 0);
      }
    }
  });

  test('a visual novel leads with where it can be played and a series with its parts', () => {
    expect(visualNovels.hubOrder).toEqual(['availability', 'about']);
    expect(lightNovels.hubOrder).toEqual(['parts']);
    const everything = hubPlan({ target: { base: 'work' }, sections: [{ id: 'statements' }, { id: 'releases' },
      { id: 'contents' }, { id: 'ratings' }, { id: 'discussion' }] });
    expect(drawOrder(everything, visualNovels.hubOrder)).toEqual(['availability', 'about', 'parts', 'ratings', 'discussion', 'lists']);
    expect(drawOrder(everything, lightNovels.hubOrder)[0]).toBe('parts');
  });

  test('leading reorders and never adds or hides a section', () => {
    const plan = hubPlan({ target: { base: 'work' }, sections: [{ id: 'statements' }] });
    expect(drawOrder(plan, ['availability', 'parts', 'about'])).toEqual(['about', 'lists']);
    expect(drawOrder(plan, ['lists', 'lists'])).toEqual(['lists', 'about']);
    // Handed over out of order, the rest still keep the documented order.
    expect(drawOrder(['lists', 'wiki', 'about', 'ratings'], ['ratings'])).toEqual(['ratings', 'about', 'wiki', 'lists']);
    expect(drawOrder(hubSections, [])).toEqual(hubSections);
    expect(drawOrder(hubSections)).toEqual(hubSections);
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

describe('G-853 inZone is honoured wherever a Work is linked', () => {
  const context = { locale: 'en' as const, ref: 'light-novels', realm: iri('5') };
  const id = iri('77');
  const title = { value: 'A Work', language: 'en', direction: 'ltr' as const, basis: 'requested' as const };

  test('a card, a summary card and a discussion link go to the canonical page when Main says the Work is not in the Zone', () => {
    const canonical = `/e/${id.slice(-36)}`;
    const card = { id, title, cover: { kind: 'fallback' as const, policy: 'zone', key: 'k', resourceType: 'work' }, types: [], tagline: null, completionStatus: null, chapterCount: null,
      wordCount: null, lastUpdatedAt: null };
    expect(zoneWork({ ...card, inZone: false }, context, null).href).toBe(canonical);
    expect(summaryWork({ id, title, inZone: false }, context).href).toBe(canonical);
    expect(replyHref(context, { id, inZone: false })).toBe(canonical);
    expect(workLink(context, id, null, 'discussion', false)).toBe(canonical);
  });

  test('a Work in the Zone, or one Main does not classify, keeps the Zone\'s own page', () => {
    expect(summaryWork({ id, title, inZone: true }, context).href).toBe(`/r/light-novels/w/${id.slice(-36)}`);
    expect(summaryWork({ id, title }, context).href).toBe(`/r/light-novels/w/${id.slice(-36)}`);
    expect(replyHref(context, { id, inZone: true })).toBe(`/r/light-novels/w/${id.slice(-36)}/discussion`);
  });
});

describe('G-853 a page reads each series once', () => {
  const answer = (language: string) => ({ ok: true as const, data: { scope: 'disclosed-composition' as const, language,
    next: null } });
  const counting = () => {
    const asked: string[] = [];
    const api = { series: async (work: string) => { asked.push(work); return answer('en'); } } as unknown as TrackingApi;
    return { api, asked };
  };

  test('the cards and the shelf of one page share a read per Work', async () => {
    const { api, asked } = counting();
    const works = ['a', 'b', 'c'].map(name => iri(name));
    await Promise.all([...works, ...works].map(item => readingOf(api, item, 'en')));
    await Promise.all(works.map(item => readingOf(api, item, 'en')));
    expect(asked.sort()).toEqual([...works].sort());
  });

  test('a page asks about no more than the cap, and the Works past it show no line', async () => {
    const { api, asked } = counting();
    const many = Array.from({ length: MAX_READS + 8 }, (_, index) => iri(String(100 + index)));
    const readings = await Promise.all(many.map(item => readingOf(api, item, 'en')));
    expect(asked).toHaveLength(MAX_READS);
    expect(readings.filter(item => item !== null)).toHaveLength(MAX_READS);
  });

  test('never more than four reads are in flight at once', async () => {
    let running = 0, peak = 0;
    const api = { series: async () => { running += 1; peak = Math.max(peak, running);
      await new Promise(done => setTimeout(done, 5)); running -= 1; return answer('en'); } } as unknown as TrackingApi;
    await Promise.all(Array.from({ length: MAX_READS }, (_, index) => readingOf(api, iri(String(200 + index)), 'en')));
    expect(peak).toBeLessThanOrEqual(4);
  });
});
