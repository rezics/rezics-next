import type { FeatureId } from '../../features.ts';
import { defineEnglishCopy } from '../define.ts';

/**
 * One statement per feature in `features.ts`; its status renders beside it, so a
 * sentence describes the product as it will work and never hedges. A title is a
 * short claim that can stand alone as a big statement; a body is one or two
 * sentences with a concrete scene.
 */
export type FeatureCopy = Record<FeatureId, { title: string; body: string }>;

export const featureCopy = defineEnglishCopy<FeatureCopy>({
  // Home: why REZICS
  'native-multilingual': {
    title: 'Every story keeps its own language.',
    body: 'Titles, editions, translations and conversations stay in the language they were written in. Your interface language never decides what you read, and nothing is quietly swapped for English.',
  },
  'portable-data': {
    title: 'Your library is yours to take.',
    body: 'Export your library, notes, reviews and drafts whole, in formats other tools read, and import them back without losing a date, a reread or an edition.',
  },
  'sourced-knowledge': {
    title: 'Knowledge shows its sources.',
    body: 'Wiki facts cite the chapter they come from. Agents propose, people review, and every change can be traced and undone.',
  },
  'api-agent-first': {
    title: 'Everything you can do, your tools can do.',
    body: 'Every action on REZICS is an API operation first, so your apps, scripts and agents work with the same powers you have, and never more.',
  },
  'open-source': {
    title: 'Built in the open.',
    body: 'The code is public: read how REZICS works, run it yourself and help improve it.',
  },
  // Home: every language, the whole community, fans together, every kind
  'names-every-script': {
    title: 'Names in every script',
    body: 'Titles, people and characters carry their names in each language and script, with readings, so a work is found however you spell it and shown the way you read it.',
  },
  'shared-tags': {
    title: 'Tags in your language',
    body: 'Tags come from one shared vocabulary, translated once for everyone, so a tag applied in Japanese reads in English, 繁體中文 or any language it has a name in.',
  },
  'reviewed-translations': {
    title: 'Synopses translated by people',
    body: 'Readers propose translations of a synopsis or a description, and others review them like any change. Until one exists you see the original, marked as such, never a guess.',
  },
  'saved-lists': {
    title: 'Lists you shape',
    body: 'Keep lists of anything on REZICS and see them as a list, a table or a gallery, filtered your way, private or shared.',
  },
  'one-identity': {
    title: 'One identity, everywhere',
    body: 'One profile follows you across every Realm, every kind of story and every language, so what you write and what you are known for stays yours wherever you post.',
  },
  'works-across-platforms': {
    title: 'Every version, one story',
    body: 'The web serial, the light novel, the manga, the anime and the game are linked as one story, each with its own releases, so fans who met it in different places arrive on the same page.',
  },
  'every-kind': {
    title: 'A complete page for every kind',
    body: 'Every kind of work gets a full page from the same parts: cover, names in every language, facts, relations, ratings, reviews, discussion, wiki, lists and sources. A new kind opens as configuration, not code.',
  },
  // Reading
  'portable-library': {
    title: 'A library that knows the edition',
    body: 'Shelve the paperback, the ebook and the translation as copies of one story, with the one you are reading marked.',
  },
  'reading-sessions': {
    title: 'Reading as it really happens',
    body: 'Rereads, pauses, books you set down and books you switch format halfway through, each recorded once, in pages, percent or minutes.',
  },
  'library-import': {
    title: 'Bring your history',
    body: 'Import from Goodreads, StoryGraph or a spreadsheet. Each row is matched to the edition you read, you choose when two look alike, and you see what will not carry over before anything changes.',
  },
  'library-export': {
    title: 'Leave with everything',
    body: 'Export the whole library with dates, notes and editions intact, and import it into REZICS or anywhere else.',
  },
  'copies-loans': {
    title: 'Owned, borrowed, due back',
    body: 'Keep the copies you own apart from the ones you borrowed and when they are due, without touching what you have read.',
  },
  'review-targets': {
    title: 'Reviews that say what they judge',
    body: 'Rate the story, the translation or the narration on its own, so a clumsy translation never sinks a great book.',
  },
  'reading-notes': {
    title: 'Notes on the passage',
    body: 'Private notes tied to the edition and the exact passage, shared only if you choose.',
  },
  // Light novels
  'series-tracking': {
    title: 'The whole series on one page',
    body: 'Japanese originals, official translations and fan translations of every volume, lined up with what you own and what you have read.',
  },
  'edition-coverage': {
    title: 'Editions that never blur',
    body: 'Volumes, omnibuses, special editions and regional releases are separate records, never guessed from a matching title.',
  },
  'translation-availability': {
    title: 'The next volume in your language',
    body: 'Follow a series in the languages you read and see which volume comes next in each, with its date once it is known.',
  },
  'release-alerts': {
    title: 'Know the day it is out',
    body: 'One note when the next volume in your language is dated or released, and none about the languages you do not read.',
  },
  'translation-provenance': {
    title: 'Official, fan or machine, always clear',
    body: 'Every translation says who made it and how. Fan groups are credited, machine translation is labelled, and progress is shown.',
  },
  'light-novels-zone': {
    title: 'The Light Novels Zone',
    body: 'New volumes, finished translations and discussion in your languages, gathered over the same catalogue as every other Zone.',
  },
  // Serial fiction
  'serial-writing': {
    title: 'A manuscript that cannot vanish',
    body: 'Every save is a revision you can restore, and a chapter written offline waits safely on your device until you reconnect.',
  },
  'serial-scheduling': {
    title: 'Publish on your schedule',
    body: 'Schedule chapters in your own time zone and see exactly which revision readers will get, and when.',
  },
  'serial-reading': {
    title: 'Pick up mid-paragraph',
    body: 'Readers return to the exact paragraph they left, on any device, and the next chapter is always one tap away.',
  },
  'chapter-discussion': {
    title: 'Talk about the chapter you just read',
    body: 'Comments sit beside the chapter, anchored to its paragraphs, and never reveal what a reader has not reached.',
  },
  collaborators: {
    title: 'Bring in your editor',
    body: 'Invite a beta reader to read, an editor to suggest and a co-author to edit, while publishing stays in your hands.',
  },
  'author-backup': {
    title: 'A backup that is complete',
    body: 'Download the whole work with its revisions, notes and world, in open formats you can import again.',
  },
  // Visual novels, anime and manga
  'vn-releases': {
    title: 'The release you can actually play',
    body: 'Filter visual novels by language, platform and edition, and compare every release side by side.',
  },
  'release-provenance': {
    title: 'Translations with a paper trail',
    body: 'See who translated a release, from which version and how complete it is, before you give it a weekend.',
  },
  'anime-episodes': {
    title: 'Anime by the episode',
    body: 'Track seasons and episodes, split cours and specials included, and discuss an episode without spoiling the next.',
  },
  'one-list': {
    title: 'One list for all of it',
    body: 'Anime, manga, novels and games on the same list, each counted in its own units: episodes, chapters, volumes or routes.',
  },
  'spoiler-position': {
    title: 'Spoilers stop where you are',
    body: 'Discussion, tags and wiki pages hold back whatever lies past the episode or chapter you have reached.',
  },
  'acgn-zone': {
    title: 'The ACGN Zone',
    body: 'This season, new releases and adaptations of the stories you follow, for people who watch, read and play.',
  },
  // Wikis and worldbuilding
  'realm-wikis': {
    title: 'A wiki for every Work',
    body: 'Characters, places, factions and events, each on its own page with an infobox, links, backlinks and discussion.',
  },
  'chapter-citations': {
    title: 'Facts that cite the chapter',
    body: 'Every statement points to the chapter and edition it comes from, so readers can check it and editors can fix it.',
  },
  'spoiler-safe-wiki': {
    title: 'Read the wiki at your chapter',
    body: 'Tell the wiki how far you have read, and every page, search result and infobox shows only what the story has revealed by then.',
  },
  'wiki-builder': {
    title: 'The wiki builder',
    body: 'Agents read licensed and author-supplied text chapter by chapter and propose sourced facts; reviewers publish them. Each Realm decides whether agents may draft for it.',
  },
  'world-bible': {
    title: 'A world bible beside the manuscript',
    body: 'Authors keep characters, places and lore privately next to the draft, then publish the pages they choose as the Work’s wiki.',
  },
  'world-visuals': {
    title: 'Maps, family trees and timelines',
    body: 'Pin places on your own map, draw relationships and set events on invented calendars, each with a readable list beside it.',
  },
  'wiki-history': {
    title: 'Every edit reviewed and reversible',
    body: 'History, diffs, review and restore on every page, and the whole wiki exports in one piece, never behind a paywall.',
  },
  // Agents
  'contribution-protocol': {
    title: 'One open protocol',
    body: 'Official and third-party agents submit the same proposals: the exact change, the evidence behind it and a confidence they must stand behind. Nothing applies without review.',
  },
  'spam-review': {
    title: 'Spam and advertising review',
    body: 'Built on TypeSafe’s Jev: typed, confidence-aware decisions that quote the passages behind them, with a person who can overrule every one.',
  },
  'auto-tagging': {
    title: 'Tags that keep up',
    body: 'Posts and books get suggested tags from the shared vocabulary, each with the reason it applies and the spoiler level it carries.',
  },
  'relation-maintenance': {
    title: 'Relations kept current',
    body: 'When a new character, person or place appears, an agent proposes it into the Works and entities it belongs to.',
  },
  normalisation: {
    title: 'Free-form posts, structured',
    body: 'A recipe written as a chatty post is proposed back to its author as a recipe with ingredients and steps.',
  },
  'migration-assistant': {
    title: 'The migration assistant',
    body: 'Brings a library over from another site, resolves editions with you and reports every row it could not match.',
  },
  'bring-your-own-agent': {
    title: 'Bring your own agent',
    body: 'Connect the agent you trust through the API or MCP. It runs on your compute, with scoped credentials and a budget you set.',
  },
  'agent-disclosure': {
    title: 'Automation always says so',
    body: 'Every agent action names the agent, who runs it and who reviewed it. REZICS never fakes reviews, votes or community members.',
  },
  // Communities
  realms: {
    title: 'Realms',
    body: 'Communities around one story, one language or one idea, each with its own rules, wiki and moderators.',
  },
  'follow-join': {
    title: 'Follow or join',
    body: 'Follow a Realm to read along; join it to take part. You always know which one you chose.',
  },
  'community-rules': {
    title: 'Rules in every language',
    body: 'A Realm states its rules once per language, and moderators apply the same rules to everyone.',
  },
  'newcomer-trust': {
    title: 'Room for newcomers, none for spam',
    body: 'New members start with gentle limits that lift as they take part, so a Realm can welcome people without welcoming bots.',
  },
  'moderation-cases': {
    title: 'Moderation you can follow',
    body: 'A report becomes a case with a decision, a stated reason and an appeal, visible to the people involved.',
  },
  recognition: {
    title: 'Recognition for real help',
    body: 'Levels in each Realm come from accepted contributions such as helpful reviews, corrections and translations, never from streaks.',
  },
  // Distribution
  'sell-books-games': {
    title: 'Books and games, sold directly',
    body: 'Contracted creators sell rights-cleared books, small games and visual novels on REZICS, with samples, updates and refunds.',
  },
  'drm-free': {
    title: 'Files that stay yours',
    body: 'DRM-free EPUB and PDF books and game builds, downloadable again from your library whenever you want them.',
  },
  'clear-statements': {
    title: 'Every deduction on the statement',
    body: 'Creators see tax, payment fees and refunds line by line, and exactly what reaches them.',
  },
  'edition-storefront': {
    title: 'Buy the exact edition',
    body: 'Readers choose the language and edition they want, and a translated edition credits its translator on the page.',
  },
  'rights-declarations': {
    title: 'Rights, stated plainly',
    body: 'Each Work says who made it, who translated it and what readers may do with it.',
  },
  'connected-store': {
    title: 'The book, its Realm and its wiki together',
    body: 'A purchase lives beside the discussion and the wiki of its Work, not in a separate store.',
  },
  // Developers
  'open-api': {
    title: 'The whole product as an API',
    body: 'Every operation a person can perform is documented, with outcomes your code can read and requests it can safely retry.',
  },
  'scoped-credentials': {
    title: 'Credentials scoped to the job',
    body: 'Give a tool exactly the access it needs, on exactly the resources it needs, and revoke it in one place.',
  },
  'actionable-errors': {
    title: 'Errors your code can act on',
    body: 'Standard problem details that say what went wrong and what to do next, from a denied scope to a stale revision.',
  },
  'event-stream': {
    title: 'Events you can resume',
    body: 'Follow changes with a durable cursor and pick up exactly where you left off after a disconnect.',
  },
  'typescript-sdk': {
    title: 'A TypeScript SDK',
    body: 'Typed clients generated from the same definitions as the API.',
  },
  'developer-portal': {
    title: 'Docs that cannot drift',
    body: 'Reference, quick starts and the list of capabilities are generated from the registry the API itself runs on.',
  },
  // Trust
  'suitability-gates': {
    title: 'Suitability you control',
    body: 'General, teen, sexual and grotesque material are separate choices, and anything unrated is treated as unrated, never as general.',
  },
  'ai-disclosure': {
    title: 'AI use, declared',
    body: 'Prose, art and translations state whether AI was used and whether a person reviewed it, and you can filter by it.',
  },
  'no-training': {
    title: 'Your drafts and reading are not training data',
    body: 'REZICS does not train on your private drafts or reading records unless you opt in, and never treats an AI detector as a verdict.',
  },
  'no-trackers': {
    title: 'No trackers',
    body: 'This site has no advertising trackers and no third-party analytics. Two cookies remember your language and theme.',
  },
  'reporting-appeals': {
    title: 'Report anything, appeal any decision',
    body: 'Anyone can report, signed in or not. Every decision comes with its reason and a way to appeal.',
  },
  'safety-response': {
    title: 'The worst harms handled first',
    body: 'Known child-abuse imagery is blocked at upload, and intimate images shared without consent come down within 48 hours of a valid report.',
  },
});
