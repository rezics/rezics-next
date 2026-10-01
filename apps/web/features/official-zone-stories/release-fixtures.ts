import type { ZoneContext, ZoneWork } from '@rezics/zone-sdk';
import { facetRegistry } from '../../../../packages/model/src/generated/facets.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { type ReleaseHit, type ReleaseRecords, type ReleaseResult, releaseWork } from '../release-filter/adapt.ts';
import { resolveReleaseFilter, type ResolvedReleaseFilter, type ServedFacet } from '../release-filter/registry.ts';
import { parseReleaseFilter, type ReleaseFilterState } from '../release-filter/state.ts';
import { presetTokens } from '../zones/presentation.ts';
import type { Realization, Release } from '../work-levels/types.ts';
import visualNovels from '../../zones/official/visual-novels/index.tsx';

// Story data for the Visual Novels and Light Novels Zones. A filtered page's cards are not written by hand: each
// story states a filter, the records a Main read would return for it (the hits with their matched release IDs,
// the releases and realizations behind them) and `releaseWork` turns them into cards, as the route does.

/** The registry as Main serves it. */
export const served = Object.values(facetRegistry) as unknown as ServedFacet[];

export const visualNovelFilter = (locale: UiLocale): ResolvedReleaseFilter =>
  resolveReleaseFilter(visualNovels.releaseFilter!(locale), served, locale)!;

export const parseFilter = (locale: UiLocale, params: Record<string, string>): ReleaseFilterState =>
  parseReleaseFilter(params, visualNovelFilter(locale));

const text = (value: string, lang = 'en') => ({ value, lang, dir: 'ltr' as const });
const id = (name: string) => `https://rezics.com/id/00000000-0000-7000-8000-${name.padStart(12, '0')}`;

export function zoneFor(slug: 'visual-novels' | 'light-novels', locale: UiLocale): ZoneContext {
  const home = `/${locale}/r/${slug}`;
  return { slug, realm: id('1'), name: text(slug === 'visual-novels' ? 'Visual Novels' : 'Light Novels'),
    description: null, icon: null, hero: null, tokens: presetTokens.editorial, locale,
    links: { home, browse: `${home}/browse`, works: `${home}/browse`, discussions: `${home}/discussions`,
      decisions: `${home}/decisions`, about: `${home}/about` } };
}

const novel = { garden: id('a1'), fable: id('a2'), crossing: id('a3'), tale: id('a4') } as const;
const coverage = (work: string, language: string, completeness: 'complete' | 'partial' | 'trial' | 'unknown',
  realization: string | null) => ({ work, mainVersion: id('9'), language, completeness, realization, revision: null });
const release = (key: string, overrides: Partial<Release>) => ({ id: id(key), platform: 'Windows', status: 'official',
  contentLanguages: ['en'], coverage: [], ...overrides }) as unknown as Release;
const realization = (key: string, language: string, translators: string[]) =>
  ({ id: id(key), language, translators }) as unknown as Realization;

/** What reading the releases Main named for the demo's four novels returns. */
const records: ReleaseRecords = {
  releases: new Map([
    // Moonlit Garden: two official English Windows releases, complete (the original and a later re-release).
    [id('r1'), release('r1', { coverage: [coverage(novel.garden, 'en', 'complete', id('t1'))] })],
    [id('r6'), release('r6', { coverage: [coverage(novel.garden, 'en', 'complete', id('t1'))] })],
    // Fan Translated Fable: Japanese complete and an English fan translation of it, complete.
    [id('r2'), release('r2', { status: 'unofficial', coverage: [coverage(novel.fable, 'en', 'complete', id('t2'))] })],
    // Starlit Crossing: an English Switch release and an English Windows one, complete.
    [id('r3'), release('r3', { platform: 'Switch', coverage: [coverage(novel.crossing, 'en', 'complete', id('t1'))] })],
    [id('r4'), release('r4', { coverage: [coverage(novel.crossing, 'en', 'complete', id('t1'))] })],
    // A fan release of a Japanese novel with no platform recorded and an unknown completeness.
    [id('r5'), release('r5', { status: 'unofficial', platform: null, contentLanguages: ['ja'],
      coverage: [coverage(novel.tale, 'ja', 'unknown', null)] })],
  ]),
  realizations: new Map([[id('t1'), realization('t1', 'en', [])],
    [id('t2'), realization('t2', 'en', [id('g1'), id('g2')])]]),
  translators: new Map([[id('g1'), text('Moonlight Translators')], [id('g2'), text('Aoi')]]),
};

const hit = (work: string, title: string, matched: string[], more = false, lang = 'en'): ReleaseHit => ({ id: work,
  title: { value: title, language: lang, direction: 'ltr', basis: 'requested' } as ReleaseHit['title'], cover: null,
  matchedReleases: matched, moreMatchedReleases: more });

/** The Main answers each story's filter would get: only Works with a release meeting every condition. */
const answers: Record<string, ReleaseHit[]> = {
  // English + Windows + complete: the fan Fable, the Garden through both its Windows releases, and Crossing through
  // its Windows one (its Switch release does not meet the platform condition, so Main does not name it).
  windows: [hit(novel.fable, 'Fan Translated Fable', [id('r2')]),
    hit(novel.garden, 'Moonlit Garden', [id('r1'), id('r6')]),
    hit(novel.crossing, 'Starlit Crossing', [id('r4')])],
  // English + Switch: only Crossing.
  switch: [hit(novel.crossing, 'Starlit Crossing', [id('r3')])],
  // English + Windows with more matching releases than a card lists.
  many: [hit(novel.garden, 'Moonlit Garden', [id('r1'), id('r6')], true)],
  // Japanese fan translations, whatever their platform and completeness.
  japaneseFan: [hit(novel.tale, '少女終末旅行', [id('r5')], false, 'ja')],
};

export type Answer = keyof typeof answers;

/** The cards of a filtered page, from the records for `answer`. */
export function results(answer: Answer, locale: UiLocale, state: ReleaseFilterState): ReleaseResult[] {
  const context = { locale, ref: 'visual-novels', realm: id('1') };
  return answers[answer]!.map(item => releaseWork(item, state, { coverKind: 'game' }, context, records));
}

export const seriesWorks: ZoneWork[] = ['Sword Art Online', 'A Certain Magical Index', 'Spice and Wolf'].map((title, index) => ({
  id: id(`b${index}`), href: `/en/r/light-novels/catalogue/${id(`b${index}`).slice(-36)}`, title: text(title), cover: null,
  kind: 'book' as const, author: null, tagline: null, status: null, chapters: null, words: null, updatedAt: null,
  decision: null }));
