import { asValue, insert, number, plural } from 'native-i18n';

// Strings for `/concepts/{id}`. English defines the contract; each locale's
// file under `messages/` overrides what it translates. The kind of value a
// Concept is ("Tags") is its Facet's label from Main, never a string here.
export const messages = {
  fromRealm: insert('From {{realm}}', { realm: String }),
  broader: 'Broader',
  narrower: 'Narrower',
  moreNarrower: 'and more',

  // The follow control, worded as on an author's page.
  followers: plural({ one: insert('{{count}} follower'), other: insert('{{count}} followers') },
    { count: asValue(number()) }),
  followersAtLeast: insert('{{count}}+ followers', { count: String }),
  follow: 'Follow',
  following: 'Following',
  unfollowName: insert('Unfollow {{name}}', { name: String }),
  signInToFollow: 'Sign in to follow',
  followFailed: 'Couldn’t update. Try again.',

  // Whose accepted values the page lists.
  scopeGlobal: 'Everyone',
  scopeRealm: insert('In {{realm}}', { realm: String }),
  scopeLabel: 'Accepted by',
  realmFallback: 'this community',

  // The Condition bar: values included or excluded, matching all or any.
  conditions: 'Conditions',
  worksWith: 'Works with',
  without: 'without',
  includedValue: insert('Included: {{name}}', { name: String }),
  excludedValue: insert('Excluded: {{name}}', { name: String }),
  pageValue: insert('{{name}}, this page’s Concept', { name: String }),
  removeValue: insert('Remove {{name}}', { name: String }),
  match: 'Match',
  matchAll: 'All',
  matchAny: 'Any',
  matchAllHelp: 'Works with every included Concept',
  matchAnyHelp: 'Works with this page’s Concept and any other included Concept',
  addConcept: 'Add a Concept',
  searchConcepts: 'Search Concepts',
  searchingConcepts: 'Searching…',
  noConcepts: 'No Concepts match',
  conceptSearchFailed: 'Couldn’t search Concepts. Try again.',
  include: 'Include',
  exclude: 'Exclude',
  includeName: insert('Include {{name}}', { name: String }),
  excludeName: insert('Exclude {{name}}', { name: String }),
  full: insert('Up to {{count}} Concepts each can be included or excluded.', { count: String }),
  alsoOn: 'Also on these works',
  clearConditions: 'Clear',

  // Search within the Concept, on today's phrase search.
  searchWithin: insert('Search within {{name}}', { name: String }),
  searchSubmit: 'Search',

  // Works reaching the Concept.
  works: 'Works',
  workCount: plural({ one: insert('{{count}} work'), other: insert('{{count}} works') }, { count: asValue(number()) }),
  workCountAtLeast: insert('{{count}}+ works', { count: String }),
  showMore: 'Show more',
  loadingMore: 'Loading more works…',
  noWorks: insert('No works with {{name}} yet', { name: String }),
  noWorksHelp: 'Works appear here once they are classified under this Concept.',
  noMatches: 'No works match these Conditions',
  noMatchesHelp: 'Remove a Concept, or match any of them instead of all.',
  stale: 'Works are being updated',
  staleHelp: 'Recent changes are still being indexed. Check back in a moment.',
  unbuilt: 'Works aren’t ready here yet',
  unbuiltHelp: 'This community’s list is still being prepared.',
  valueMissing: 'A Concept in this link isn’t available',
  valueMissingHelp: 'It may have been retired or hidden. Show the works without it.',
  invalidConditions: 'These Conditions can’t be combined',
  worksUnavailable: 'Couldn’t load works',
  worksUnavailableHelp: 'REZICS could not reach this list. Try again in a moment.',
  moved: 'The list changed',
  movedHelp: 'Works were added or changed while you browsed. Start again from the top.',
  retry: 'Retry',
  startOver: 'Start over',
  seeEveryone: 'See everyone’s works',
  showAll: insert('Show all works with {{name}}', { name: String }),

  malformed: 'This link’s Conditions aren’t valid',
  malformedHelp: 'A value is repeated, both included and excluded, or not a Concept.',
  unavailableTitle: 'This Concept can’t be shown right now',
  unavailableBody: 'REZICS could not reach it. Try again in a moment.',

  metaTitle: insert('{{name}} — works', { name: String }),
  metaDescription: insert('Works on REZICS classified as {{name}}.', { name: String }),
};

export type ConceptMessages = typeof messages;
