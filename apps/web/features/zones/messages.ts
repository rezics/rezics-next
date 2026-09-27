import { asValue, insert, number, plural } from 'native-i18n';

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
  safeModeTitle: 'Showing this community’s standard layout',
  safeModeBody: 'Its custom design is off for this page, so everything here uses the platform’s own components.',
  showDesign: 'Show the full design',
  // The default layout's module titles.
  picks: 'Featured', genres: 'Genres', latest: 'Latest', newChapters: 'New chapters',
  newlyAdded: 'Newly added', recentlyCompleted: 'Completed', rankings: 'Rankings',
  quotes: 'Fresh from readers', rising: 'New and rising', decisions: 'Recent decisions',
};

export type ZoneMessages = typeof messages;
