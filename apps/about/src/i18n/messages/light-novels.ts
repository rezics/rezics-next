import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const lightNovels = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Light novels on REZICS: every volume, every translation, one series',
    description:
      'Follow a light novel across Japanese originals, official and fan translations. See what you own and read, and know the day the next volume is out in your language.',
  },
  hero: {
    title: 'Know which volume comes next.',
    lede: 'The Japanese original, the English release, the Traditional Chinese edition and the fan translation that got there first: REZICS lines up every volume of a series, marks what you own and have read, and tells you when the next one arrives in your language.',
  },
  story: {
    title: 'One series, every edition.',
    lede: 'Follow a series the way you actually read it: in more than one language, bought in more than one place.',
    steps: {
      lined: {
        title: 'Every edition, lined up.',
        body: 'Each volume appears once per language and edition. Volume 7 in Japanese, in English and in Traditional Chinese are three books you can tell apart at a glance.',
      },
      yours: {
        title: 'What you own, what you have read.',
        body: 'Mark the paperback on your shelf, the ebook you finished and the translation you are waiting for. Your place in the series stays the same whichever edition you read.',
      },
      next: {
        title: 'The next volume, the day it is out.',
        body: 'When volume 7 is dated in 繁體中文, the date appears on your series page. On release day you get one note, and only for the languages you follow.',
      },
      provenance: {
        title: 'Official, fan or machine, always clear.',
        body: 'Every translation says who made it and how far it has got. Fan groups are credited by name, and machine translation is labelled as machine translation.',
      },
    },
  },
  showcase: {
    title: 'Made for how the scene reads.',
    lede: 'Light novels arrive in parts, omnibuses, special editions and several languages at once. REZICS keeps each one straight.',
    tiles: {
      omnibus: {
        title: 'Omnibuses and special editions',
        body: 'An omnibus lists the volumes inside it, and a special edition keeps its extras. Nothing merges because two titles match.',
      },
      calendar: {
        title: 'A release calendar in your languages',
        body: 'This month’s volumes in the languages you read, each date marked confirmed or expected.',
      },
      zone: {
        title: 'The Light Novels Zone',
        body: 'New volumes, finished translations and discussion in your languages, over the same catalogue as every other Zone.',
      },
      wiki: {
        title: 'A wiki for the series',
        body: 'Characters and places cite their chapters, and nothing past the volume you have reached is shown.',
      },
    },
  },
  compare: {
    title: 'From a spreadsheet to one series page.',
    lede: 'Keeping up with a series across languages shouldn’t take three tabs and a notebook.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      spreadsheet: {
        today: 'A spreadsheet of the volumes you own',
        rezics: 'Owned, read and next, marked on the series',
      },
      newsletters: {
        today: 'Publisher newsletters in three languages',
        rezics: 'One note when your language’s volume is out',
      },
      official: {
        today: 'Guessing whether a translation is official',
        rezics: 'Every translation labelled and credited',
      },
      stores: {
        today: 'Purchases scattered across stores and countries',
        rezics: 'Every copy you own recorded in one library',
      },
    },
  },
  statement: {
    text: 'The next volume, in the language you read, on the day it is out.',
    body: 'Light novels lead because they need everything REZICS is built on: distinct editions, native languages and a library that remembers.',
  },
  ledger: {
    title: 'Light novels on REZICS',
    lede: 'Each capability shows where it stands today.',
  },
  cta: {
    title: 'Follow your first series on day one.',
    body: 'Leave your email and we will write once, when registration opens.',
  },
});
