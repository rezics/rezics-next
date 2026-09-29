import type { KindKey } from '../../illustrations/sample.ts';
import { defineEnglishCopy } from '../define.ts';

/**
 * Interface words inside the illustrations, which are drawn from real Rezics UI components.
 * Sample titles, names and quoted text are sample data in their own languages (`sample.ts`
 * and the components), not copy.
 */
export interface IllustrationCopy {
  /** Each kind of story's name and one fact its page shows, for the home page's kinds. */
  kinds: Record<KindKey, { name: string; fact: string }>;
  deck: { previous: string; next: string; position: string };
  record: {
    showIn: string;
    originalTitle: string;
    story: string;
    illustration: string;
    synopsis: string;
    tags: string;
    editions: string;
    original: string;
    untranslated: string;
    suggest: string;
  };
  thread: {
    yourPlace: string;
    chapterOf: string;
    about: string;
    later: string;
    realm: string;
    wikiName: string;
    role: string;
    revealedLater: string;
  };
  realm: {
    name: string;
    members: string;
    webSerial: string;
    lightNovel: string;
    manga: string;
    anime: string;
    game: string;
    cameFrom: Record<'serial' | 'anime' | 'game' | 'edition', string>;
  };
  shelf: {
    read: string;
    owned: string;
    reading: string;
    next: string;
    upcoming: string;
    volume: string;
    volumes: string;
    yourPlace: string;
    chapter: string;
    paperback: string;
    ebook: string;
    audiobook: string;
    borrowed: string;
    dueBack: string;
  };
  release: {
    note: string;
    out: string;
    friday: string;
    dated: string;
    expected: string;
    original: string;
    official: string;
    fan: string;
    machine: string;
    translatedBy: string;
    covers: string;
    complete: string;
    platform: string;
  };
  importer: {
    file: string;
    matched: string;
    choose: string;
    unmatched: string;
    notCarried: string;
    apply: string;
  };
  serial: {
    stoppedHere: string;
    comments: string;
    scheduled: string;
    when: string;
    revision: string;
    saved: string;
  };
  wiki: {
    character: string;
    place: string;
    firstAppears: string;
    safeThrough: string;
    hiddenUntil: string;
    sources: string;
    reviewed: string;
    apprenticeAt: string;
    keeps: string;
    teaches: string;
    rivals: string;
    siblings: string;
    home: string;
    teacher: string;
    family: string;
    sourceLine: string;
    faction: string;
    item: string;
    lore: string;
    public: string;
    private: string;
  };
  library: {
    counted: string;
    formats: string;
    page: string;
    minute: string;
    firstRead: string;
    reread: string;
    setAside: string;
    finished: string;
    note: string;
    private: string;
    story: string;
    translation: string;
    narration: string;
    export: string;
    fileNotes: string;
    fileDates: string;
    fileShelves: string;
    nothingApplied: string;
    sources: string;
    nowReading: string;
  };
  desk: {
    chapter: string;
    noSignal: string;
    waitingToSync: string;
    restore: string;
    latest: string;
    goesOutAs: string;
    atTime: string;
    yourTime: string;
    readerTime: string;
    laterHidden: string;
    onParagraph: string;
    author: string;
    editor: string;
    betaReader: string;
    coAuthor: string;
    reads: string;
    suggests: string;
    edits: string;
    publishes: string;
    revisions: string;
    notes: string;
    world: string;
    openFormat: string;
    aiNone: string;
    aiAssisted: string;
    aiDrafted: string;
    aiDetail: string;
    character: string;
    original: string;
    translation: string;
  };
  acgn: {
    route: string;
    episode: string;
    ofTotal: string;
    madeFrom: string;
    translationGroup: string;
    released: string;
    hiddenUntil: string;
    posts: string;
    unlocked: string;
    thisSeason: string;
    airs: string;
    adaptation: string;
    heldBack: string;
    source: string;
    voice: string;
    director: string;
    asCharacter: string;
    zoneTabs: { seasons: string; releases: string; discussion: string };
  };
  community: {
    conversation: string;
    knowledge: string;
    confirmedIn: string;
    startedIn: string;
    keepInWiki: string;
    rules: string;
    sameForEveryone: string;
    follow: string;
    join: string;
    followBlurb: string;
    joinBlurb: string;
    readAlong: string;
    post: string;
    reply: string;
    review: string;
    newcomer: string;
    limits: string;
    limitsLift: string;
    postsPerDay: string;
    case: string;
    reason: string;
    decision: string;
    appeal: string;
    appealOpen: string;
    removed: string;
    readIn: string;
    translatedFrom: string;
    agentsMayHelp: string;
    off: string;
    setByRealm: string;
    level: string;
    accepted: string;
    perContribution: string;
  };
  store: {
    edition: string;
    translator: string;
    sample: string;
    price: string;
    tax: string;
    total: string;
    buy: string;
    receipt: string;
    inLibrary: string;
    noDrm: string;
    downloadAgain: string;
    files: string;
    version: string;
    corrected: string;
    patched: string;
    earlierKept: string;
    statement: string;
    sales: string;
    paymentFees: string;
    refunds: string;
    payout: string;
    madeBy: string;
    readersMay: string;
    readersMayDo: string;
    store: string;
    follow: string;
    creator: string;
    book: string;
    game: string;
  };
  api: {
    website: string;
    yourCode: string;
    sameOperation: string;
    credential: string;
    oneLibrary: string;
    oneTask: string;
    revoke: string;
    revocableHere: string;
    preview: string;
    firstAttempt: string;
    retry: string;
    sameReceipt: string;
    cursor: string;
    disconnected: string;
    resumeHere: string;
    problem: string;
    cause: string;
    nextStep: string;
    typed: string;
    generated: string;
    operation: string;
  };
  trust: {
    suitability: string;
    teen: string;
    sexual: string;
    grotesque: string;
    shown: string;
    hidden: string;
    unrated: string;
    neverGeneral: string;
    report: string;
    privateLink: string;
    anyone: string;
    flagged: string;
    person: string;
    passage: string;
    rule: string;
    whatChanged: string;
    outcome: string;
    upheld: string;
    reviewedAgain: string;
    recorded: string;
    reviewedByPerson: string;
    privateDraft: string;
    training: string;
    optIn: string;
    advertisingTrackers: string;
    analytics: string;
    none: string;
    blockedAtUpload: string;
    abuseImagery: string;
    within48: string;
    intimateImages: string;
  };
  agent: {
    proposal: string;
    automated: string;
    runBy: string;
    readRevision: string;
    confidence: string;
    evidence: string;
    accept: string;
    edit: string;
    reject: string;
    accepted: string;
    receipt: string;
    reviewedBy: string;
    reversed: string;
    keptEdits: string;
    unsolicitedAd: string;
    ownWork: string;
    moderatorDecides: string;
    queue: string;
    remove: string;
    keep: string;
    historyApplied: string;
    historyHuman: string;
    historyReversed: string;
    scopes: string;
    budget: string;
    setByYou: string;
    matchedCount: string;
    chooseCount: string;
    unmatchedCount: string;
    proposedFact: string;
    proposedLink: string;
  };
}

export const illustrations = defineEnglishCopy<IllustrationCopy>({
  kinds: {
    webSerial: { name: 'Web serial', fact: 'Chapter 24 on Friday, 20:00 your time' },
    lightNovel: { name: 'Light novel', fact: 'Vol. 7 in English, dated 2 October' },
    book: { name: 'Book', fact: 'Paperback, ebook and audiobook as one work' },
    visualNovel: { name: 'Visual novel', fact: 'Original, official and fan releases' },
    anime: { name: 'Anime', fact: 'Episode 7 of 12, season two dated' },
    manga: { name: 'Manga', fact: 'Chapter 41, and Vol. 5 in French' },
    game: { name: 'Game', fact: 'PC and Switch, version 1.4' },
    software: { name: 'Software', fact: 'Every version with its release notes' },
    aiPrompt: { name: 'AI prompt', fact: 'Rated on three models, runs attached' },
    recipe: { name: 'Recipe', fact: 'Serves four, 35 minutes' },
    wiki: { name: 'Wiki and world', fact: 'Places and people cited to the chapter' },
    community: { name: 'Community', fact: 'One Realm, rules in three languages' },
  },
  deck: { previous: 'Previous', next: 'Next', position: '{n} of {total}' },
  record: {
    showIn: 'Show in',
    originalTitle: 'Original title',
    story: 'Story',
    illustration: 'Illustration',
    synopsis: 'Synopsis',
    tags: 'Tags',
    editions: 'Editions',
    original: 'Original',
    untranslated: 'No {language} translation yet. This is the original.',
    suggest: 'Suggest a translation',
  },
  thread: {
    yourPlace: 'Your place in the story',
    chapterOf: 'Chapter {n} of {total}',
    about: 'Chapter {n}',
    later: 'Posts about later chapters stay hidden until you reach them.',
    realm: 'Discussion',
    wikiName: 'Ren Tachibana',
    role: 'Role',
    revealedLater: 'Revealed later',
  },
  realm: {
    name: 'The Lantern Archive',
    members: 'Readers, viewers and players in one Realm',
    webSerial: 'Web serial',
    lightNovel: 'Light novel',
    manga: 'Manga',
    anime: 'Anime',
    game: 'Game',
    cameFrom: {
      serial: 'Followed the web serial',
      anime: 'Came from the anime',
      game: 'Played the game first',
      edition: 'Reads the 繁體中文 edition',
    },
  },
  shelf: {
    read: 'Read',
    owned: 'Owned',
    reading: 'Reading',
    next: 'Next',
    upcoming: 'Upcoming',
    volume: 'Vol. {n}',
    volumes: 'Vol. {from}–{to}',
    yourPlace: 'Your place',
    chapter: 'Chapter {n}',
    paperback: 'Paperback',
    ebook: 'Ebook',
    audiobook: 'Audiobook',
    borrowed: 'Borrowed',
    dueBack: 'Due back {day}',
  },
  release: {
    note: 'Vol. {n} in {language}',
    out: 'Out {day}',
    friday: 'Friday',
    dated: 'Dated',
    expected: 'Expected',
    original: 'Original',
    official: 'Official translation',
    fan: 'Fan translation',
    machine: 'Machine translation',
    translatedBy: 'Translated by {name}',
    covers: 'Covers {n}% of the game',
    complete: 'Complete',
    platform: 'Platform',
  },
  importer: {
    file: 'library-export.csv',
    matched: 'Matched to the {year} paperback',
    choose: 'Two editions look alike. Which one did you read?',
    unmatched: 'No match yet. Kept in your report.',
    notCarried: 'Not carried over: custom shelf colours',
    apply: 'Apply import',
  },
  serial: {
    stoppedHere: 'You stopped here',
    comments: 'Discuss this chapter',
    scheduled: 'Scheduled',
    when: 'Friday 20:00, your time',
    revision: 'Revision {n}',
    saved: 'Saved on this device',
  },
  wiki: {
    character: 'Character',
    place: 'Place',
    firstAppears: 'First appears',
    safeThrough: 'Safe through chapter {n}',
    hiddenUntil: 'Hidden until chapter {n}',
    sources: 'Sources',
    reviewed: 'Reviewed',
    apprenticeAt: 'apprentice at',
    keeps: 'keeps',
    teaches: 'teaches',
    rivals: 'rival of',
    siblings: 'siblings',
    home: 'Home',
    teacher: 'Teacher',
    family: 'Family',
    sourceLine: 'English edition, chapters 1 to 9',
    faction: 'Faction',
    item: 'Item',
    lore: 'Lore',
    public: 'Public',
    private: 'Private',
  },
  library: {
    counted: 'Counted as one read',
    formats: 'Formats',
    page: 'Page {n} of {total}',
    minute: 'Minute {n}',
    firstRead: 'First read',
    reread: 'Reread',
    setAside: 'Set aside',
    finished: 'Finished',
    note: 'Note on this passage',
    private: 'Only you can see this',
    story: 'Story',
    translation: 'Translation',
    narration: 'Narration',
    export: 'Export library',
    fileNotes: 'Notes and passages',
    fileDates: 'Reads with dates',
    fileShelves: 'Shelves and copies',
    nothingApplied: 'Nothing applied yet',
    sources: 'From Goodreads, StoryGraph or a spreadsheet',
    nowReading: 'Now reading',
  },
  desk: {
    chapter: 'Chapter {n}',
    noSignal: 'No signal',
    waitingToSync: 'Waiting to sync',
    restore: 'Restore',
    latest: 'Latest',
    goesOutAs: 'Goes out as',
    atTime: '{day} {time}',
    yourTime: 'Your time',
    readerTime: 'Reader in {city}',
    laterHidden: 'Comments on chapter {n} stay hidden until you reach it.',
    onParagraph: 'On paragraph {n}',
    author: 'You',
    editor: 'Editor',
    betaReader: 'Beta reader',
    coAuthor: 'Co-author',
    reads: 'Reads',
    suggests: 'Suggests',
    edits: 'Edits',
    publishes: 'Publishes',
    revisions: 'Every revision',
    notes: 'Notes',
    world: 'World',
    openFormat: 'Open format',
    aiNone: 'No AI',
    aiAssisted: 'AI-assisted',
    aiDrafted: 'AI-drafted',
    aiDetail: 'Pacing suggestions on chapters 3 to 9, each reviewed by the author.',
    character: 'Character',
    original: 'Original',
    translation: 'Translation',
  },
  acgn: {
    route: 'Route {n}',
    episode: 'Episode {n}',
    ofTotal: '{n} of {total}',
    madeFrom: 'Made from the original, version {n}',
    translationGroup: 'Translation group',
    released: 'Released',
    hiddenUntil: 'Hidden until {place}',
    posts: 'Discussion',
    unlocked: 'You have reached this',
    thisSeason: 'This season',
    airs: 'Airs {day}',
    adaptation: 'Adaptation',
    heldBack: 'Held back: beyond volume 3',
    source: 'Source',
    voice: 'Voice',
    director: 'Director',
    asCharacter: 'as {name}',
    zoneTabs: { seasons: 'Seasons', releases: 'Releases', discussion: 'Discussion' },
  },
  community: {
    conversation: 'Conversation',
    knowledge: 'Wiki',
    confirmedIn: 'Confirmed in chapter {n}',
    startedIn: 'Started in this thread',
    keepInWiki: 'Keep in the wiki',
    rules: 'Rules',
    sameForEveryone: 'The same for everyone',
    follow: 'Follow',
    join: 'Join',
    followBlurb: 'Read along quietly',
    joinBlurb: 'Take part',
    readAlong: 'Read discussion',
    post: 'Post',
    reply: 'Reply',
    review: 'Review',
    newcomer: 'New member',
    limits: 'Gentle limits',
    limitsLift: 'They lift as you take part',
    postsPerDay: '{n} posts a day',
    case: 'Case',
    reason: 'Reason',
    decision: 'Decision',
    appeal: 'Appeal',
    appealOpen: 'Appeal open',
    removed: 'Removed',
    readIn: 'Read in {language}',
    translatedFrom: 'Posted in {language}',
    agentsMayHelp: 'Agents may help',
    off: 'Off',
    setByRealm: 'Set by the Realm',
    level: 'Level {n}',
    accepted: '{n} accepted contributions',
    perContribution: 'Earned from accepted help, never streaks',
  },
  store: {
    edition: 'Edition',
    translator: 'Translator',
    sample: 'Read a sample',
    price: 'Price',
    tax: 'Tax',
    total: 'Total',
    buy: 'Buy',
    receipt: 'Receipt',
    inLibrary: 'In your library',
    noDrm: 'DRM-free',
    downloadAgain: 'Download again',
    files: 'Files',
    version: 'Version {n}',
    corrected: 'Corrected edition',
    patched: 'Patched build',
    earlierKept: 'Earlier versions stay available',
    statement: 'Statement',
    sales: 'Sales',
    paymentFees: 'Payment fees',
    refunds: 'Refunds',
    payout: 'Paid out',
    madeBy: 'Made by',
    readersMay: 'Readers may',
    readersMayDo: 'Keep it and read it on any device',
    store: 'Store',
    follow: 'Follow',
    creator: 'Creator',
    book: 'Book',
    game: 'Game',
  },
  api: {
    website: 'The website',
    yourCode: 'Your code',
    sameOperation: 'One operation, two clients',
    credential: 'Credential',
    oneLibrary: 'One library',
    oneTask: 'One task',
    revoke: 'Revoke',
    revocableHere: 'Revocable in one place',
    preview: 'Preview',
    firstAttempt: 'First attempt',
    retry: 'Retry after a timeout',
    sameReceipt: 'Same receipt, no second import',
    cursor: 'Cursor',
    disconnected: 'Disconnected',
    resumeHere: 'Resumes exactly here',
    problem: 'Problem details',
    cause: 'Cause',
    nextStep: 'Next step',
    typed: 'Typed from the same definitions as the API',
    generated: 'Generated',
    operation: 'Operation',
  },
  trust: {
    suitability: 'What you see',
    teen: 'Teen',
    sexual: 'Sexual',
    grotesque: 'Grotesque',
    shown: 'Shown',
    hidden: 'Hidden',
    unrated: 'Unrated',
    neverGeneral: 'Unrated is never shown as general',
    report: 'Report',
    privateLink: 'A private link to follow this case',
    anyone: 'Anyone, signed in or not',
    flagged: 'Flagged by an automated check',
    person: 'Decided by a person',
    passage: 'The reported passage',
    rule: 'Rule applied',
    whatChanged: 'What changed',
    outcome: 'Outcome',
    upheld: 'Decision upheld',
    reviewedAgain: 'Reviewed again',
    recorded: 'Recorded with the case',
    reviewedByPerson: 'Reviewed by a person',
    privateDraft: 'Private draft',
    training: 'Used for training',
    optIn: 'Only if you opt in',
    advertisingTrackers: 'Advertising trackers',
    analytics: 'Third-party analytics',
    none: 'None',
    blockedAtUpload: 'Blocked at upload',
    abuseImagery: 'Known abuse imagery',
    within48: 'Removed within 48 hours',
    intimateImages: 'Intimate images shared without consent',
  },
  agent: {
    proposal: 'Proposed tags',
    automated: 'Automated',
    runBy: 'Tagging agent, run by {name}',
    readRevision: 'Read revision {n}',
    confidence: 'Confidence {n}%',
    evidence: 'Evidence',
    accept: 'Accept',
    edit: 'Edit',
    reject: 'Reject',
    accepted: 'Applied',
    receipt: 'Receipt {id}',
    reviewedBy: 'Reviewed by {name}',
    reversed: 'Reversed',
    keptEdits: 'Later human edits kept',
    unsolicitedAd: 'Unsolicited advertisement',
    ownWork: 'Author announcing their own book',
    moderatorDecides: 'A moderator decides',
    queue: 'Spam and advertising review',
    remove: 'Remove',
    keep: 'Keep',
    historyApplied: 'Tags applied by the tagging agent',
    historyHuman: 'Tag added by {name}',
    historyReversed: 'Agent change reversed',
    scopes: 'Scopes',
    budget: 'Budget',
    setByYou: 'Set by you',
    matchedCount: '{n} matched',
    chooseCount: '{n} to choose',
    unmatchedCount: '{n} not matched',
    proposedFact: 'Proposed fact',
    proposedLink: 'Proposed link',
  },
});
