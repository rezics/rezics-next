import type { ZoneContext, ZoneMatchedRelease, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { presetTokens } from '../zones/presentation.ts';
import type { ReleaseResult } from './adapt.ts';

// Story data for the Visual Novels and Light Novels Zones: what a release-filtered page and a series page
// show for the demo's slice, including the Works whose release facts are thin.

const text = (value: string, lang = 'en'): ZoneText => ({ value, lang, dir: 'ltr' });
const realm = 'https://rezics.com/id/01a0e4b7-0a00-7000-8000-000000000001';

export function zoneFor(slug: 'visual-novels' | 'light-novels', locale: UiLocale): ZoneContext {
  const home = `/${locale}/r/${slug}`;
  return { slug, realm, name: text(slug === 'visual-novels' ? 'Visual Novels' : 'Light Novels'),
    description: null, icon: null, hero: null, tokens: presetTokens.editorial, locale,
    links: { home, browse: `${home}/browse`, works: `${home}/browse`, discussions: `${home}/discussions`,
      decisions: `${home}/decisions`, about: `${home}/about` } };
}

const id = (name: string) => `https://rezics.com/id/00000000-0000-7000-8000-${name.padStart(12, '0')}`;

function work(key: string, title: string, lang: string, kind: ZoneWork['kind'] = 'game'): ZoneWork {
  return { id: id(key), href: `/en/r/visual-novels/w/${id(key).slice(-36)}`, title: text(title, lang), cover: null, kind,
    author: null, tagline: null, status: null, chapters: null, words: null, updatedAt: null, decision: null };
}

const release = (key: string, overrides: Partial<ZoneMatchedRelease>): ZoneMatchedRelease => ({ id: id(key),
  language: 'en', platform: 'Windows', completeness: 'complete', origin: 'official', translators: [], ...overrides });

/** The filtered results "English + Windows + complete": a fan translation, an official release and a thin record. */
export const filtered: ReleaseResult[] = [
  { work: work('a1', 'Steins;Gate', 'en'), matches: { more: false, releases: [release('r1', { origin: 'unofficial',
    translators: [text('Translation Club')] })] } },
  { work: work('a2', 'Ever17 -the out of infinity-', 'en'), matches: { more: true, releases: [release('r2',
    { platform: 'Switch' }), release('r3', { platform: 'Windows' })] } },
  // A fan release whose translator is not recorded, and one whose completeness is unknown: said as such.
  { work: work('a3', '少女終末旅行', 'ja'), matches: { more: false, releases: [release('r4',
    { origin: 'unofficial', completeness: 'unknown', language: 'ja', platform: null })] } },
];

export const seriesZone = (locale: UiLocale) => zoneFor('light-novels', locale);
export const seriesWorks: ZoneWork[] = [work('b1', 'Sword Art Online', 'en', 'book'),
  work('b2', 'A Certain Magical Index', 'en', 'book'), work('b3', 'Spice and Wolf', 'en', 'book')]
  .map(item => ({ ...item, href: `/en/r/light-novels/w/${item.id.slice(-36)}` }));
