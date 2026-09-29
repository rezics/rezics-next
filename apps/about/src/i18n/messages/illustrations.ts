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
