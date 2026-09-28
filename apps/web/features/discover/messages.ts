import { insert } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';
import zhHans from './messages/zh-Hans.ts';

const en = {
  title: 'Discover',
  description: 'Find your next book, guide or recipe.',
  titleRealm: insert('Discover in {{realm}}', { realm: String }),
  descriptionRealm: 'What this community reads and rates.',
  titleMine: 'Your ratings',
  descriptionMine: 'Public works you rated, your favorites first.',
  community: 'Whose picks', everyone: 'Everyone', mine: 'Your ratings',
  realmFallback: insert('Community {{id}}', { id: String }),
  typeFilter: 'Kind of work', allTypes: 'All', book: 'Books', document: 'Guides', recipe: 'Recipes',
  favoritesAll: 'Readers’ favorites', favoritesBook: 'Readers’ favorites', favoritesDocument: 'Highly rated guides',
  favoritesRecipe: 'Top-rated recipes',
  recentAll: 'Recently added', recentBook: 'Recently added', recentDocument: 'Guides and references',
  recentRecipe: 'Recipes to try',
  popularIn: insert('Popular in {{genre}}', { genre: String }),
  newIn: insert('New in {{genre}}', { genre: String }),
  thisGenre: 'this genre',
  mineShelf: 'Works you rated',
  genreFilter: insert('Genre: {{genre}}', { genre: String }), genreUnknown: 'Genre',
  removeFilter: insert('Remove {{filter}}', { filter: String }),
  showMore: 'Show more', loadingMore: 'Loading more…', startOver: 'Start over', retry: 'Try again',
  signIn: 'Sign in',
  empty: 'Nothing here yet', emptyHelp: 'Works appear here as they are published.',
  seeEverything: 'See everyone’s picks',
  preparing: 'This list is being prepared',
  preparingHelp: 'New and changed works appear here after the next update. Check back soon.',
  preparingAll: 'These lists are being prepared', somePreparing: 'Some lists are still being prepared',
  preparingMeanwhile: 'They appear after the next update. Meanwhile, here is what readers are reading.',
  emptyMeanwhile: 'Meanwhile, here is what readers are reading.',
  trending: 'Trending this week', trendingIn: insert('Trending in {{realm}}', { realm: String }),
  fromEveryone: 'From everyone on REZICS',
  moved: 'This list changed while you were browsing',
  movedHelp: 'Start over to see it as it is now.',
  unavailableShelf: insert('Couldn’t load {{shelf}}', { shelf: String }),
  unavailableHelp: 'REZICS didn’t answer in time.',
  missingShelf: 'This list isn’t available here',
  missingHelp: 'Its rating question may have been retired, or it belongs to another community.',
  signInTitle: 'Sign in to see works you rated',
  signInHelp: 'Your ratings are private to you.',
  invalidTitle: 'This list can’t be shown with these filters',
  budgetTitle: 'This list is too large to show right now',
  noRatingsYet: 'Ratings aren’t open here yet',
  noRatingsHelp: 'Once readers can rate works here, the ones you rated appear on this page.',
  badLinkTitle: 'This link doesn’t lead anywhere',
  badLinkHelp: 'Something in the address isn’t a filter Discover knows.',
  realmMissingTitle: 'This community isn’t public or doesn’t exist',
  browseEverything: 'Browse everything',
};

export const englishMessages = en;

export const messages = defineMessages({ en, 'zh-Hans': zhHans });

export type DiscoverMessages = typeof en;
