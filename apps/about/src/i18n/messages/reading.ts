import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const reading = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Reading on REZICS: a library that remembers every edition',
    description:
      'Import your reading history, keep every edition and reread, track what you own and borrowed, and export all of it whenever you want. A library that goes wherever you read.',
  },
  hero: {
    title: 'A library that remembers every edition.',
    lede: 'The paperback you own, the ebook you finished on the train, the audiobook you switched to halfway, the library copy due back on Friday. REZICS keeps them as one story read your way, and lets you take the whole record with you.',
  },
  story: {
    title: 'Move in without starting over.',
    lede: 'Years of reading history come with you, edition by edition.',
    steps: {
      upload: {
        title: 'Bring your export.',
        body: 'Drop in the file from Goodreads, StoryGraph or your own spreadsheet. Nothing changes in your library until you say so.',
      },
      match: {
        title: 'Each book finds its edition.',
        body: 'Rows are matched to the edition you actually read. When two look alike, say a 2019 paperback and its 2021 reissue, you choose, and REZICS never guesses from a title alone.',
      },
      preview: {
        title: 'See what will not carry over.',
        body: 'Before anything is applied, a preview lists every row that could not be matched and every field the source could not express, so nothing disappears quietly.',
      },
      resume: {
        title: 'Pick up where you were.',
        body: 'Your current reads arrive with their page, percent or minute, and rereads and set-aside books keep their history.',
      },
    },
  },
  showcase: {
    title: 'Reading the way it actually happens.',
    lede: 'Real reading is messy. The record should be honest about it.',
    tiles: {
      formats: {
        title: 'One read, many formats',
        body: 'Start in print, finish on audio, count it once.',
      },
      rereads: {
        title: 'Rereads and set-asides',
        body: 'Every reread is its own session; a book you set down stays set down, not failed.',
      },
      copies: {
        title: 'Owned, borrowed, due back',
        body: 'Copies and loans live apart from what you have read.',
      },
      notes: {
        title: 'Notes on the passage',
        body: 'Private notes tied to the edition and the exact place.',
      },
      reviews: {
        title: 'Reviews that say what they judge',
        body: 'Story, translation and narration rated on their own.',
      },
      export: {
        title: 'Leave with everything',
        body: 'Export the whole library, notes and dates included.',
      },
    },
  },
  compare: {
    title: 'A reading record that survives the move.',
    lede: 'Most libraries are easy to enter and hard to leave.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      editions: {
        today: 'Every edition a separate book, reviews split between them',
        rezics: 'One story, its editions kept distinct and together',
      },
      rereads: {
        today: 'A reread overwrites the first read',
        rezics: 'Each read is its own session',
      },
      export: {
        today: 'Exports that drop notes and dates',
        rezics: 'A complete export you can import again',
      },
      sync: {
        today: 'Three apps to update after every chapter',
        rezics: 'One record, reachable by the tools you use',
      },
    },
  },
  statement: {
    text: 'Your reading life is a record worth keeping. Keep it.',
    body: 'Everything you log on REZICS can leave with you, whole, whenever you want.',
  },
  ledger: {
    title: 'Reading on REZICS',
    lede: 'Each capability shows where it stands today.',
  },
  cta: {
    title: 'Bring your library on day one.',
    body: 'Leave your email and we will write once, when registration opens.',
  },
});
