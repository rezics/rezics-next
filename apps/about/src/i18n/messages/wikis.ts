import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const wikis = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Wikis and worldbuilding on REZICS: a wiki as deep as the story',
    description:
      'A wiki for every Work, where each fact cites its chapter and readers see only what they have read. Agents draft from sources, people review, and authors keep a world bible.',
  },
  hero: {
    title: 'A wiki as deep as the story.',
    lede: 'Every Work gets a wiki that grows with it: characters, places and relations, each fact citing the chapter it comes from, shown only as far as you have read. Agents draft from the sources. People decide what is published.',
  },
  story: {
    title: 'Watch a wiki grow, chapter by chapter.',
    lede: 'Each chapter adds what the story has revealed, and nothing more.',
    steps: {
      arrival: {
        title: 'Chapter 1: someone arrives.',
        body: 'A character steps into the story. Her page starts with one fact and the line it comes from.',
      },
      place: {
        title: 'Chapter 4: a place, a connection.',
        body: 'The archive enters the story. The wiki adds the place and links it to the people who keep it.',
      },
      relations: {
        title: 'Chapter 9: relations take shape.',
        body: 'Teacher, rival, sister: relations appear when the text states them, never guessed because two names share a page.',
      },
      reveal: {
        title: 'Chapter 12: a secret, held back.',
        body: 'The reveal is recorded with its chapter. Anyone who has not reached chapter 12 will not meet it on the page, in search or in the infobox.',
      },
    },
  },
  showcase: {
    title: 'For the fans who keep the record, and the authors who build the world.',
    lede: 'The same pages serve a Realm’s public wiki and an author’s private world bible.',
    tiles: {
      bible: {
        title: 'A world bible beside the draft',
        body: 'Characters, places, factions, items and lore, kept privately next to the manuscript.',
      },
      publish: {
        title: 'Publish the pages you choose',
        body: 'Turn selected pages into the Work’s wiki without exposing drafts or their history.',
      },
      maps: {
        title: 'Maps on your own art',
        body: 'Pin places on a map you drew. Every pin is in a list as well.',
      },
      timelines: {
        title: 'Timelines on invented calendars',
        body: 'Set events in your world’s own calendar, with uncertain dates allowed.',
      },
      relations: {
        title: 'Relationship maps',
        body: 'Families, alliances and rivalries as a graph, and as a list anyone can read.',
      },
      history: {
        title: 'History, review and export',
        body: 'Diffs and restore on every page, and the whole wiki exports in one piece.',
      },
    },
  },
  compare: {
    title: 'What a fan wiki becomes.',
    lede: 'The people who keep a story’s record deserve tools that keep it honest.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      spoilers: {
        today: 'Next season’s twist in this season’s infobox',
        rezics: 'Every page stops at the chapter you reached',
      },
      sources: {
        today: 'Facts nobody can trace',
        rezics: 'Each fact cites its chapter and edition',
      },
      generated: {
        today: 'Generated articles with invented citations',
        rezics: 'Agents propose sourced facts; people publish',
      },
      scattered: {
        today: 'Lore split across three writing apps',
        rezics: 'One world bible beside the manuscript',
      },
      leaving: {
        today: 'An export that leaves half the wiki behind',
        rezics: 'The whole wiki, exported and importable',
      },
    },
  },
  statement: {
    text: 'Agents propose. People decide. Every fact shows its source.',
    body: 'Fan wikis are right to reject generated articles. REZICS agents propose sourced facts and structure, and nothing reaches readers until a person has reviewed it. Each Realm decides whether agents may draft for it at all.',
  },
  ledger: {
    title: 'Wikis and worldbuilding on REZICS',
    lede: 'Each capability shows where it stands today.',
  },
  cta: {
    title: 'Start your world’s wiki when we open.',
    body: 'Leave your email and we will write once, when registration opens.',
  },
});
