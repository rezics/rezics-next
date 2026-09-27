import { asValue, insert, number, plural } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';
import zhHans from './messages/zh-Hans.ts';

// Strings for the cover-first cards, shelves and reader actions that Discover,
// Search, the Work page and the home feed share. Components read them by UI
// locale, so each page does not have to load and pass them.
const en = {
  untitled: insert('Work {{id}}', { id: String }),
  fallbackTitle: 'Title shown in another language',
  ratingCount: plural({ one: insert('{{count}} rating'), other: insert('{{count}} ratings') },
    { count: asValue(number()) }),
  averageRating: insert('Average rating {{mean}} out of {{max}}, {{count}}', { mean: String, max: String, count: String }),
  ownRating: insert('Your rating: {{value}} out of {{max}}', { value: String, max: String }),
  yourRating: 'Your rating',
  noRatings: 'No ratings yet',
  previous: 'Previous', next: 'Next', seeAll: 'See all',
  wantToRead: 'Want to read', reading: 'Currently reading', read: 'Read',
  removeFromShelf: 'Remove from my shelves',
  shelve: insert('Shelve “{{title}}”', { title: String }),
  shelfOptions: 'More shelves',
  signInToShelve: 'Sign in to keep a reading list',
  rateThis: 'Rate this work',
  signInToRate: 'Sign in to rate this work',
  saving: 'Saving…',
  saveFailed: 'Couldn’t save. Try again.',
  ongoing: 'Ongoing', hiatus: 'On hiatus',
};

export const englishMessages = en;

export const messages = defineMessages({ en, 'zh-Hans': zhHans });

export type CatalogueMessages = typeof en;
