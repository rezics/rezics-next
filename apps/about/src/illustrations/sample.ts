/**
 * Sample works, people and groups for the illustrations. All are invented, so no real
 * title, author or translator is implied; each keeps its own language, as catalogue data
 * would. Typographic covers are generated from these ids, never copyrighted art.
 */

/**
 * Book cloth for spines drawn outside WorkCover, in WorkCover's own book palette
 * (packages/ui/src/components/work-cover.tsx): each edition of a series wears its own.
 */
const cream = 'oklch(0.96 0.025 85)';
const gold = 'oklch(0.82 0.1 85)';
export const cloths = {
  inkBlue: { ground: 'oklch(0.36 0.09 255)', ink: cream, accent: gold },
  oxblood: { ground: 'oklch(0.37 0.11 22)', ink: cream, accent: gold },
  forest: { ground: 'oklch(0.38 0.07 158)', ink: cream, accent: gold },
  teal: {
    ground: 'oklch(0.41 0.07 210)',
    ink: 'oklch(0.97 0.02 85)',
    accent: 'oklch(0.84 0.09 85)',
  },
  plum: { ground: 'oklch(0.36 0.08 320)', ink: cream, accent: gold },
  ochre: { ground: 'oklch(0.8 0.11 80)', ink: 'oklch(0.26 0.04 55)', accent: 'oklch(0.4 0.1 35)' },
} as const;

/** One light novel series in three editions. The shared id gives every edition the same ink-blue cloth. */
export const lantern = {
  id: '2b52d8c0-0e31-4c14-9b52-d8c00e31ac14',
  author: { ja: '佐藤 澪', 'zh-Hant': '佐藤澪', en: 'Mio Sato' },
  editions: [
    { lang: 'ja', title: '灯籠の書庫', released: 9 },
    { lang: 'zh-Hant', title: '燈籠書庫', released: 6 },
    { lang: 'en', title: 'The Lantern Archive', released: 7 },
  ],
} as const;

export type Edition = (typeof lantern.editions)[number];
export type EditionLang = Edition['lang'];

/** A second series, for shelves and imports. */
export const saltMarsh = {
  id: '5a1e0b7c-6d2f-4b83-a9c4-0e1f2a3b4c01',
  en: 'Salt Marsh Chronicle',
  'zh-Hant': '鹽澤紀事',
  author: 'Rena Voss',
} as const;

/** Other books on a reader's shelf. */
export const shelf = [
  {
    id: 'b7f1c2d3-11aa-4e21-9c10-aa01bb02cc03',
    title: 'Northern Lights Atlas',
    lang: 'en',
    author: 'J. Alder',
  },
  { id: 'c4d5e6f7-22bb-4f32-8d21-bb12cc23dd34', title: 'Tidewater', lang: 'en', author: 'R. Voss' },
  {
    id: 'd9e8f7a6-44dd-4b65-9f43-dd45ee56ff67',
    title: '夜明けの測量士',
    lang: 'ja',
    author: '高瀬 灯',
  },
  { id: 'e1a2b3c4-55ee-4c76-8a54-ee56ff67aa78', title: '霧港', lang: 'zh-Hant', author: '林澄' },
] as const;

/** A visual novel with three releases. */
export const glassTide = {
  id: 'e1f2a3b4-33cc-4a43-9e32-cc23dd34ee45',
  title: 'Glass Tide',
  original: 'ガラスの潮',
  releases: [
    { lang: 'ja', platform: 'PC', kind: 'original', by: 'Studio Hoshizora', done: 100 },
    {
      lang: 'en',
      platform: 'Switch',
      kind: 'official',
      by: 'Marsh Lantern Localization',
      done: 100,
    },
    { lang: 'zh-Hant', platform: 'PC', kind: 'fan', by: '澤燈漢化組', done: 74 },
  ],
} as const;

/** A web serial and its author. */
export const serial = {
  id: 'f2b3c4d5-66ff-4d87-9b65-ff67aa78bb89',
  title: 'The Cartographer’s Debt',
  author: 'Noor Hale',
  chapter: 23,
} as const;

/** The world of The Lantern Archive, as its wiki records it. */
export const world = {
  kaede: 'Kaede Aoi',
  ren: 'Ren Tachibana',
  iori: 'Iori Sakuma',
  archive: 'The Lantern Archive',
  marsh: 'The Salt Marsh',
} as const;

/**
 * The word "story" in the interface languages and some of the many content languages
 * beyond them, for the home page's word band. Content is never limited to the eight.
 */
export const storyWords = [
  { lang: 'en', text: 'Story' },
  { lang: 'ja', text: '物語' },
  { lang: 'ko', text: '이야기' },
  { lang: 'de', text: 'Geschichte' },
  { lang: 'vi', text: 'Câu chuyện' },
  { lang: 'hi', text: 'कहानी' },
  { lang: 'pl', text: 'Opowieść' },
  { lang: 'zh-Hant', text: '故事' },
  { lang: 'fr', text: 'Histoire' },
  { lang: 'es', text: 'Historia' },
  { lang: 'uk', text: 'Історія' },
  { lang: 'id', text: 'Kisah' },
  { lang: 'it', text: 'Storia' },
  { lang: 'tr', text: 'Hikâye' },
] as const;
