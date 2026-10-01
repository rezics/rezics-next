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
  // The browse page and the search the home leads with.
  browseTab: 'Browse',
  browseTitle: insert('Browse {{zone}}', { zone: String }),
  searchLabel: insert('Search {{zone}}', { zone: String }),
  searchPlaceholder: insert('Search {{zone}}…', { zone: String }),
  search: 'Search', browseAll: 'Browse all',
  sortLabel: 'Sort by', sortRelevance: 'Relevance', sortNewest: 'Newest', sortUpdated: 'Recently updated',
  viewLabel: 'View', viewList: 'List', viewGrid: 'Grid',
  filters: 'Filters', filtersChosen: insert('Filters ({{count}})', { count: String }),
  clearAll: 'Clear all filters', removeFilter: insert('Remove filter: {{label}}', { label: String }),
  exclude: 'Exclude', excluded: 'Excluded',
  removeExclusion: insert('Remove exclusion: {{label}}', { label: String }),
  chosen: 'selected', showAllValues: 'Show all',
  results: plural({ one: insert('{{count}} result'), other: insert('{{count}} results') }, { count: asValue(number()) }),
  resultsAtLeast: insert('{{count}}+ results', { count: String }),
  windowNote: insert('Filters look through this community’s {{count}} newest picks.', { count: String }),
  tagsStale: 'Tags are catching up with the latest changes. Try again in a moment.',
  tagsUnavailable: 'Tags can’t be used as filters right now.',
  browseEmptyTitle: 'Nothing matches these filters',
  browseEmptyBody: 'Remove a filter, or search for something else.',
  facetStatus: 'Status', facetLength: 'Length', facetConcept: 'Tags', facetType: 'Type',
  envClient: 'Client', envServer: 'Server', envBoth: 'Client and server',
  statusOngoing: 'Ongoing', statusCompleted: 'Completed', statusHiatus: 'On hiatus',
  length0: 'Under 100k words', length1: '100k–300k words', length2: '300k–1M words', length3: 'Over 1M words',
  updated: insert('Updated {{ago}}', { ago: String }),
  chapters: plural({ one: insert('{{count}} chapter'), other: insert('{{count}} chapters') }, { count: asValue(number()) }),
  words: insert('{{count}} words', { count: String }),
  // A mod Work's release list.
  modVersions: 'Versions', modChangelog: 'Changelog', modVersion: 'Version', modGameVersions: 'Game versions',
  modLoaders: 'Loaders', modPublished: 'Published', modEnvironments: 'Environments', modChannel: 'Channel',
  modNoNotes: 'No notes for this release.',
  modUnavailable: 'Couldn’t load this mod’s versions.',
  modChannelRelease: 'Release', modChannelBeta: 'Beta', modChannelAlpha: 'Alpha',
  modChannelUnknown: 'Channel unknown',
  modMoreVersions: 'Showing the 20 newest disclosed releases.',
  // A page missing inside a community that is still here.
  pageMissingTitle: 'This page isn’t here',
  pageMissingBody: 'The address may be wrong, or the page may have moved.',
  pageMissingBack: 'Back to this community',
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
