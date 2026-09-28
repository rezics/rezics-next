import { asValue, insert, number, plural } from 'native-i18n';
import type { ZoneModuleType } from '@rezics/zone-sdk';

export const messages = {
  more: 'More', shuffle: 'Shuffle',
  whyHere: insert('Why {{title}} is here', { title: String }),
  untitled: 'Untitled work',
  rank: insert('No. {{rank}}', { rank: String }),
  day: 'Today', week: 'This week', month: 'This month', completed: 'Completed',
  newChapter: insert('New: {{chapter}}', { chapter: String }),
  heroLabel: 'Featured', previous: 'Previous', next: 'Next',
  slide: insert('{{index}} of {{count}}', { index: String, count: String }),
  read: 'Start reading', readWork: 'See the work',
  dismiss: 'Dismiss', announcement: 'Announcement',
  adopted: insert('Added {{title}}', { title: String }), adoptedUnknown: 'Added a work',
  classified: insert('Classified {{title}}', { title: String }), classifiedUnknown: 'Classified a work',
  classificationRejected: insert('Declined a classification of {{title}}', { title: String }),
  classificationRejectedUnknown: 'Declined a classification',
  ruleChanged: 'Changed a community rule',
  quoteBy: insert('{{reader}} on', { reader: String }),
  replies: plural({ one: insert('{{count}} reply'), other: insert('{{count}} replies') },
    { count: asValue(number()) }),
  failed: insert('Couldn’t load {{module}}', { module: String }), retry: 'Try again',
  lookLabel: 'Page style', lookZone: 'Community design', lookStandard: 'Standard look',
  lookHelp: 'The standard look applies to every community.',
  lookSaveFailed: 'Couldn’t save your page style. Try again.',
  safeModeTitle: 'Showing this community’s standard layout',
  safeModeBody: 'Its custom design is off for this page, so everything here uses the platform’s own components.',
  showDesign: 'Show the full design',
  // The default layout's module titles.
  picks: 'Featured', genres: 'Genres', latest: 'Latest', newChapters: 'New chapters',
  newlyAdded: 'Newly added', recentlyCompleted: 'Completed', rankings: 'Rankings',
  quotes: 'Fresh from readers', rising: 'New and rising', decisions: 'Recent decisions',
  moduleHeroCarousel: 'Featured', moduleChipNav: 'Browse', moduleAnnouncement: 'Announcement',
  moduleShelf: 'Latest', moduleRanking: 'Rankings', moduleEditorialList: 'Editors’ picks',
  moduleQuoteStream: 'Reader quotes', moduleRising: 'New and rising', moduleDecisionLog: 'Recent decisions',
  moduleDiscussionList: 'Discussions', modulePeople: 'People',
};

export type ZoneMessages = typeof messages;

type ModuleTitleKey = 'moduleHeroCarousel' | 'moduleChipNav' | 'moduleAnnouncement' | 'moduleShelf' |
  'moduleRanking' | 'moduleEditorialList' | 'moduleQuoteStream' | 'moduleRising' | 'moduleDecisionLog' |
  'moduleDiscussionList' | 'modulePeople';

const moduleTitleKeys: Record<ZoneModuleType, ModuleTitleKey> = {
  'hero-carousel': 'moduleHeroCarousel', 'chip-nav': 'moduleChipNav', announcement: 'moduleAnnouncement',
  shelf: 'moduleShelf', ranking: 'moduleRanking', 'editorial-list': 'moduleEditorialList',
  'quote-stream': 'moduleQuoteStream', rising: 'moduleRising', 'decision-log': 'moduleDecisionLog',
  'discussion-list': 'moduleDiscussionList', people: 'modulePeople',
};

/** A localized fallback heading when a Zone has no title for the current locale. */
export function defaultModuleTitle(type: ZoneModuleType, localized: Pick<ZoneMessages, ModuleTitleKey>): string {
  return localized[moduleTitleKeys[type]];
}
