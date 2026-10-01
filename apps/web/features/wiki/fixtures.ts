import type { HomeSlotProps, ZoneContext, ZoneEntity, ZoneHomeSection, ZoneMember, ZonePositionState, ZoneText,
  ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { presetTokens } from '../zones/presentation.ts';
import type { PositionChoiceOption } from './position-control.tsx';

// Story and test data for the franchise wiki Zone: what the platform's reads return for a small wiki of
// Pride and Prejudice at different positions. Every name below is a record "Main returned"; the slot tests assert
// that nothing else is drawn.

export const text = (value: string, lang = 'en'): ZoneText => ({ value, lang, dir: 'ltr' });
const id = (name: string) => `https://rezics.com/id/00000000-0000-7000-8000-${name.padStart(12, '0')}`;
const page = (segment: string, name: string) => `/r/franchise-wiki/${segment}/${id(name).slice(-36)}`;

export function zoneFor(locale: UiLocale): ZoneContext {
  const home = `/${locale}/r/franchise-wiki`;
  return { slug: 'franchise-wiki', realm: id('1'), name: text('Franchise Wiki'),
    description: text('Characters, places and chapters, up to where you have read.'), icon: null, hero: null,
    tokens: presetTokens.editorial, locale,
    links: { home, browse: `${home}/browse`, works: `${home}/browse`, discussions: `${home}/discussions`,
      decisions: `${home}/decisions`, about: `${home}/about` } };
}

const member = (segment: string, key: string, name: string, kind: string | null, lang = 'en'): ZoneMember =>
  ({ id: id(key), href: page(segment, key), name: text(name, lang), kind });

export const chapters: ZoneMember[] = ['Chapter 1', 'Chapter 2', 'Chapter 3'].map((name, index) =>
  member('chapters', `c${index + 1}`, name, 'Chapter'));
export const characters: ZoneMember[] = [
  member('characters', 'e1', 'Elizabeth Bennet', 'Character'), member('characters', 'e2', 'Jane Bennet', 'Character'),
  member('characters', 'e3', 'Fitzwilliam Darcy', 'Character')];
export const places: ZoneMember[] = [member('places', 'p1', 'Meryton', 'Place'), member('places', 'p2', 'Netherfield Park', 'Place')];
export const events: ZoneMember[] = [member('events', 'v1', 'The Meryton assembly', 'Event')];

export const work: ZoneWork = { id: id('w1'), href: '/r/franchise-wiki/franchise/w1', title: text('Pride and Prejudice'),
  cover: null, kind: 'book', author: text('Jane Austen'), tagline: null, status: null, chapters: 3, words: null,
  updatedAt: null, decision: null };

const section = (segment: string, name: string, members: ZoneMember[] = [], works: ZoneWork[] = [], more = false): ZoneHomeSection =>
  ({ segment, name: text(name), href: `/r/franchise-wiki/${segment}`, works, members, more });

/** Nothing published yet: the Work is in the wiki, its lists are empty. */
export const emptyHome: ZoneHomeSection[] = [section('franchise', 'Works', [], [work]), section('characters', 'Characters'),
  section('places', 'Places'), section('events', 'Events'), section('chapters', 'Chapters')];
/** Chapter 1 only: some lists have pages, some do not yet. */
export const youngHome: ZoneHomeSection[] = [section('franchise', 'Works', [], [work]), section('characters', 'Characters', characters.slice(0, 2)),
  section('places', 'Places', places.slice(0, 1)), section('events', 'Events'), section('chapters', 'Chapters', chapters.slice(0, 1))];
export const fullHome: ZoneHomeSection[] = [section('franchise', 'Works', [], [work]), section('characters', 'Characters', characters),
  section('places', 'Places', places), section('events', 'Events', events), section('chapters', 'Chapters', chapters)];
export const noWorksHome: ZoneHomeSection[] = [section('franchise', 'Works'), section('characters', 'Characters')];

export const atChapter1: ZonePositionState = { mode: 'default', label: text('Chapter 1'), showAllHref: '/r/franchise-wiki?position=all' };
export const atChapter3: ZonePositionState = { mode: 'chosen', label: text('Volume 1 · Chapter 3'), showAllHref: '/r/franchise-wiki?position=all' };
export const atEverything: ZonePositionState = { mode: 'all', label: null, showAllHref: null };

export const homeProps = (sections: ZoneHomeSection[], position: ZonePositionState): Pick<HomeSlotProps, 'sections' | 'position'> =>
  ({ sections, position });

const link = (name: string, key: string, segment = 'characters') => ({ name: text(name), href: page(segment, key) });

/** A character page at the position where her sister and the assembly are revealed. */
export const elizabeth: ZoneEntity = { id: id('e1'), kind: 'Character', name: text('Elizabeth Bennet'),
  aliases: [text('Lizzy'), text('Eliza'), text('エリザベス・ベネット', 'ja')],
  facts: [{ label: 'Family', values: [{ text: text('Bennet family'), href: null }] },
    { label: 'Lives at', values: [{ text: text('Longbourn'), href: null }] }],
  relationships: [{ label: 'Sisters', others: [link('Jane Bennet', 'e2')] },
    { label: 'Acquaintances', others: [link('Fitzwilliam Darcy', 'e3')] }],
  evidence: [{ id: id('q1'), text: text('The Bennet family'), withheld: false, supports: 'Family: Bennet family',
    modality: 'narrated', rights: 'public_domain', mediaType: 'text/plain', agent: 'Holder extraction agent' }],
  firstSeen: { name: text('Chapter 1'), href: page('chapters', 'c1') }, more: false,
  fullPage: `/e/${id('e1').slice(-36)}`, chapter: null };

/** The same page when the quotation is under a rights restriction: the passage is withheld, its source stays. */
export const elizabethWithheld: ZoneEntity = { ...elizabeth, evidence: [{ ...elizabeth.evidence[0]!, text: null, withheld: true }] };
/** A young record: a name and nothing else yet. */
export const janeYoung: ZoneEntity = { id: id('e2'), kind: 'Character', name: text('Jane Bennet'), aliases: [], facts: [],
  relationships: [], evidence: [], firstSeen: { name: text('Chapter 1'), href: page('chapters', 'c1') }, more: true,
  fullPage: `/e/${id('e2').slice(-36)}`, chapter: null };

const neighbour = (name: string, key: string) => ({ name: text(name), href: page('chapters', key) });
/** A chapter page the reader has reached: what it adds to each list. */
export const chapter2: ZoneEntity = { id: id('c2'), kind: 'Chapter', name: text('Chapter 2'), aliases: [], facts: [],
  relationships: [], evidence: [], firstSeen: null, more: false, fullPage: `/e/${id('c2').slice(-36)}`,
  chapter: { reached: true, previous: neighbour('Chapter 1', 'c1'), next: neighbour('Chapter 3', 'c3'),
    reveals: [{ segment: 'characters', name: text('Characters'), members: characters.slice(2), complete: true },
      { segment: 'places', name: text('Places'), members: places.slice(1), complete: false }] } };
/** A chapter beyond the reader: Main has revealed nothing, and the page says so. */
export const chapter3Ahead: ZoneEntity = { ...chapter2, id: id('c3'), name: text('Chapter 3'),
  chapter: { reached: false, previous: neighbour('Chapter 2', 'c2'), next: null, reveals: [] } };

export const options: PositionChoiceOption[] = ['Chapter 1', 'Chapter 2', 'Chapter 3'].map((name, index) =>
  ({ id: `c${index + 1}`, label: text(name), href: `/r/franchise-wiki?position=c${index + 1}`, current: index === 2 }));
