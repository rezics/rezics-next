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

  // A new person
  pickTitle: 'What do you come to REZICS for?',
  pickBody: 'Choose a few. We’ll suggest communities to follow, and you can change this any time.',
  step: insert('Step {{step}} of {{total}}', { step: String, total: String }),
  languagesTitle: 'Which languages do you read?',
  languagesBody: 'We’ll suggest communities that post in them.',
  communitiesTitle: 'Follow a few communities',
  communitiesBody: 'Picked for what you chose. Untick any you don’t want.',
  noSuggestions: 'No suggestions yet. Browse Discover to find communities.',
  findingCommunities: 'Finding communities…',
  back: 'Back', next: 'Next', skip: 'Skip for now',
  followAndContinue: plural({ one: insert('Follow {{count}} and continue'), other: insert('Follow {{count}} and continue') },
    { count: asValue(number()) }),
  continueWithoutFollowing: 'Continue without following',
  following: 'Following…', followFailed: 'Couldn’t follow them. Try again.',
  pickLaterTitle: 'Make Home yours', pickLaterBody: 'Pick your interests and follow a few communities.',
  pickStart: 'Pick interests',
  reasonPopular: 'Popular on REZICS', reasonOfficial: 'Official Zone',
  reasonKind: insert('For {{kind}}', { kind: String }),
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
};

export type HomeMessages = typeof messages;
