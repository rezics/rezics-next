import { asValue, insert, number, plural } from 'native-i18n';

export const messages = {
  title: 'Home',

  // Continue
  continueTitle: 'Continue reading',
  newChapters: plural({ one: insert('{{count}} new'), other: insert('{{count}} new') }, { count: asValue(number()) }),
  newChaptersAtLeast: plural({ one: insert('{{count}}+ new'), other: insert('{{count}}+ new') },
    { count: asValue(number()) }),
  nextChapter: insert('Next: {{chapter}}', { chapter: String }), nextUp: 'Pick up where you left off',
  continueWork: insert('Continue “{{title}}”', { title: String }),
  hideFromContinue: insert('Hide “{{title}}” from Continue', { title: String }),
  hiddenFromContinue: insert('“{{title}}” is hidden from Continue.', { title: String }),
  hideFailed: 'Couldn’t hide it. Try again.', undo: 'Undo',
  scrollBack: 'Scroll back', scrollForward: 'Scroll forward',

  // Signed out
  welcomeTitle: 'Follow communities to shape your Home',
  welcomeBody: 'Join the Realms behind the works you love. Their new chapters, picks and discussions fill this page.',
  signUp: 'Join REZICS', signIn: 'Sign in', dismiss: 'Dismiss',
  officialZones: 'Official Zones', officialZonesIntro: 'Curated by REZICS’s own Realms',

  // A new person, and a Home with no pinned tabs yet
  inviteTitle: 'Make Home yours',
  inviteBody: 'Pick the languages you read and a few topics. Each topic becomes a tab here, and we’ll suggest communities to follow.',
  inviteStart: 'Choose topics', inviteLater: 'Not now',
  inviteLaterBody: 'Pin topics as tabs whenever you like.',

  // Pinned tabs
  pinTopic: 'Pin a topic', pinMore: 'Pin a topic or filter',
  tabOptions: insert('Options for {{tab}}', { tab: String }),
  renameTab: 'Rename', moveLeft: 'Move left', moveRight: 'Move right', unpinTab: 'Remove from Home',
  unfollowTopic: insert('Unfollow {{topic}}', { topic: String }), deleteFilter: 'Delete filter',
  untitledTab: 'Untitled', tabsFailed: 'Couldn’t change your tabs. Try again.',
  tabsChanged: 'Your tabs changed somewhere else, so here are the latest.',
  renameTitle: 'Rename tab', tabName: 'Name', save: 'Save', cancel: 'Cancel',
  useTopicName: insert('Use “{{topic}}”', { topic: String }),
  tabMissing: 'This tab isn’t on your Home any more', tabMissingBody: 'It may have been removed in another window.',
  emptyPinned: insert('Nothing about {{topic}} yet', { topic: String }),
  emptyPinnedBody: 'Posts appear here when people share, review or discuss works with this topic.',
  emptyPinnedFilter: 'Nothing matches this tab yet',
  openTopic: insert('Open {{topic}}', { topic: String }),
  tabUnsupported: 'Home can’t show this filter’s posts yet.',

  // The pin picker
  pinTitle: 'Pin to Home', pinBody: 'Topics and filters you pin become tabs after Following and All.',
  searchTopics: 'Search topics', searching: 'Searching…', noTopics: 'No topics match.',
  searchFailed: 'Topics couldn’t be searched. Try again.', yourTopics: 'Your topics',
  popularTopics: 'Popular topics', broader: 'Broader', narrower: 'Narrower',
  pinThis: insert('Pin “{{topic}}”', { topic: String }), openTab: 'Open its tab', back: 'Back',
  tabsFull: 'Home has room for eight tabs. Remove one to add another.',
  saveFilters: 'Save these filters as a tab', saveFiltersBody: 'The languages and communities you’re filtering by now.',
  saveTab: 'Save as tab', pinFailed: 'Couldn’t pin it. Try again.',

  // Suggestions in a quiet Following
  suggestionsOn: 'Suggested posts fill in while your communities are quiet.', turnOff: 'Turn off',
  suggestionsOff: 'Suggestions are off in Following.', turnOn: 'Turn on',
  suggestionsFailed: 'Couldn’t save that. Try again.',

  // Suggested communities
  reasonPopular: 'Popular on REZICS',
  reasonConcept: insert('For {{concept}}', { concept: String }),
  members: plural({ one: insert('{{count}} member'), other: insert('{{count}} members') }, { count: asValue(number()) }),
  membersAbout: plural({ one: insert('About {{count}} member'), other: insert('About {{count}} members') },
    { count: asValue(number()) }),

  // The rail
  sidebar: 'More on REZICS',
  trendingFollowed: 'Trending in your Realms', trendingGlobal: 'Trending this week',
  trendingEmpty: 'Nothing is trending yet this week.',
  realmsToFollow: 'Realms to follow', popularRealms: 'Popular Realms',
  follow: 'Follow', followed: 'Following', followRealm: insert('Follow {{realm}}', { realm: String }),
  followOneFailed: 'Couldn’t follow. Try again.',
  queueTitle: 'Your moderation queue',
  queueWaiting: insert('{{count}} waiting', { count: String }), queueClear: 'Nothing waiting',
  openManage: 'Open Manage',
  howHomeWorks: 'How Home works',
  howBest: insert('Best ranks posts by readers’ votes, fading over about {{hours}} hours, and compares each post with others from its own Realm.',
    { hours: String }),
  howCap: insert('No Realm fills more than {{cap}} of any {{window}} posts in a row.', { cap: String, window: String }),
  howNew: 'New is strictly newest first. Top counts votes in the period you choose.',
  howFollowing: 'Following shows the Realms, Zones and works you follow. Suggestions appear there only when it is quiet, and are marked.',
  howPinned: 'A pinned tab shows the posts from All that match its topic or filters, sorted the same way.',
};

export type HomeMessages = typeof messages;
