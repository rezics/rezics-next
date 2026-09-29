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

/** A name in one language, as the catalogue records it. */
export interface Name {
  lang: string;
  text: string;
}

/**
 * The kinds of story the home page shows, each with one invented work named in the
 * scripts it circulates in (its original first) and the cover kind that suits it.
 */
export const kindsOfStory = [
  {
    key: 'lightNovel',
    cover: 'book',
    id: lantern.id,
    names: [
      { lang: 'ja', text: lantern.editions[0].title },
      { lang: 'en', text: lantern.editions[2].title },
      { lang: 'zh-Hant', text: lantern.editions[1].title },
      { lang: 'ko', text: '등롱 서고' },
    ],
  },
  {
    key: 'visualNovel',
    cover: 'package',
    id: glassTide.id,
    names: [
      { lang: 'ja', text: glassTide.original },
      { lang: 'en', text: glassTide.title },
      { lang: 'zh-Hant', text: '玻璃之潮' },
      { lang: 'hi', text: 'काँच का ज्वार' },
    ],
  },
  {
    key: 'webSerial',
    cover: 'book',
    id: serial.id,
    names: [
      { lang: 'en', text: serial.title },
      { lang: 'zh-Hant', text: '製圖師的債' },
      { lang: 'ru', text: 'Долг картографа' },
      { lang: 'es', text: 'La deuda del cartógrafo' },
    ],
  },
  {
    key: 'anime',
    cover: 'document',
    id: '0c3d4e5f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    names: [
      { lang: 'ja', text: '星屑ステーション' },
      { lang: 'en', text: 'Stardust Station' },
      { lang: 'ko', text: '별먼지 정거장' },
      { lang: 'zh-Hant', text: '星塵車站' },
    ],
  },
  {
    key: 'manga',
    cover: 'book',
    id: '1d4e5f60-8b9c-4dae-9f10-2b3c4d5e6f70',
    names: [
      { lang: 'ja', text: '夜行書店' },
      { lang: 'en', text: 'The Night Bookshop' },
      { lang: 'fr', text: 'La Librairie de nuit' },
      { lang: 'ko', text: '야행 서점' },
    ],
  },
  {
    key: 'game',
    cover: 'package',
    id: '2e5f6071-9cad-4ebf-a021-3c4d5e6f7081',
    names: [
      { lang: 'en', text: 'Hollow Orchard' },
      { lang: 'de', text: 'Der hohle Obstgarten' },
      { lang: 'ja', text: 'うろの果樹園' },
      { lang: 'uk', text: 'Порожній сад' },
    ],
  },
  {
    key: 'aiPrompt',
    cover: 'document',
    id: '3f607182-adbe-4fc0-b132-4d5e6f708192',
    names: [
      { lang: 'en', text: 'The Rain-Soaked Narrator' },
      { lang: 'ja', text: '雨の語り手' },
      { lang: 'zh-Hant', text: '雨夜旁白' },
      { lang: 'pt', text: 'O narrador da chuva' },
    ],
  },
  {
    key: 'recipe',
    cover: 'recipe',
    id: '40718293-becf-40d1-8243-5e6f708192a3',
    names: [
      { lang: 'ko', text: '할머니 떡볶이' },
      { lang: 'en', text: 'Grandmother’s tteokbokki' },
      { lang: 'ja', text: 'おばあちゃんのトッポッキ' },
      { lang: 'zh-Hant', text: '奶奶的辣炒年糕' },
    ],
  },
] as const satisfies readonly {
  key: string;
  cover: 'book' | 'document' | 'recipe' | 'package';
  id: string;
  names: readonly Name[];
}[];

export type StoryKind = (typeof kindsOfStory)[number]['key'];

/**
 * The Lantern Archive's record as each reading language presents it. Titles, credits and
 * tags have names in all four; the synopsis has no Korean translation yet, so Korean
 * readers see the Japanese original, marked.
 */
export const lanternRecord = {
  languages: ['ja', 'en', 'zh-Hant', 'ko'],
  title: {
    ja: lantern.editions[0].title,
    en: lantern.editions[2].title,
    'zh-Hant': lantern.editions[1].title,
    ko: '등롱 서고',
  },
  /** The author, with the reading of each part of the Japanese name. */
  author: {
    ja: [
      { text: '佐藤', reading: 'さとう' },
      { text: '澪', reading: 'みお' },
    ],
    en: 'Mio Sato',
    'zh-Hant': '佐藤澪',
    ko: '사토 미오',
  },
  illustrator: {
    ja: '森野ひかる',
    en: 'Hikaru Morino',
    'zh-Hant': '森野ひかる',
    ko: '모리노 히카루',
  },
  synopsis: {
    ja: '灯籠の火が消えると、その本は二度と読めなくなる。港町の古い書庫で働く楓は、消えかけた一冊を守るため、灯籠番の少年・蓮と夜の書架へ向かう。',
    en: 'When a lantern goes out, its book can never be read again. Kaede, who works in an old archive in a harbour town, goes into the night stacks with Ren, the boy who keeps the lanterns, to save a book that is fading.',
    'zh-Hant':
      '燈籠一熄滅，那本書就再也無法閱讀。在港町古老書庫工作的楓，為了守住一本即將消失的書，和守燈少年蓮一起走進夜晚的書架。',
  },
  tags: [
    { ja: 'ファンタジー', en: 'Fantasy', 'zh-Hant': '奇幻', ko: '판타지' },
    { ja: '図書館', en: 'Libraries', 'zh-Hant': '圖書館', ko: '도서관' },
    { ja: '港町', en: 'Harbour towns', 'zh-Hant': '港口小鎮', ko: '항구 마을' },
    { ja: '成長物語', en: 'Coming of age', 'zh-Hant': '成長故事', ko: '성장물' },
  ],
} as const;

export type RecordLang = (typeof lanternRecord.languages)[number];

/**
 * A Realm's discussion of The Lantern Archive: each post is about a chapter, and a reader
 * sees only the posts about chapters they have reached. Handles and posts are invented.
 */
export const lanternThread = {
  chapters: 30,
  posts: [
    {
      id: 'p1',
      chapter: 3,
      by: 'mira.reads',
      lang: 'en',
      text: 'Kaede sorting the lanterns by the smell of their smoke is my favourite detail so far.',
    },
    {
      id: 'p2',
      chapter: 8,
      by: 'つきよみ',
      lang: 'ja',
      text: '8章の洪水の帳簿、読む手が止まった。',
    },
    {
      id: 'p3',
      chapter: 12,
      by: 'harbourlight',
      lang: 'en',
      text: 'Chapter 12 finally explains why the archive only opens at night. Worth the wait.',
    },
    {
      id: 'p4',
      chapter: 19,
      by: '霧港讀者',
      lang: 'zh-Hant',
      text: '原來蓮一直都知道帳簿的事，第19章的對話全都有了新的意思。',
    },
    {
      id: 'p5',
      chapter: 27,
      by: 'ledger_keeper',
      lang: 'en',
      text: 'Nobody warned me about the last lantern in chapter 27. I am not okay.',
    },
  ],
  /** Ren's wiki facts and the chapter that reveals each. */
  facts: [
    { key: 'role', chapter: 1, lang: 'en', text: 'Keeper of the lanterns' },
    { key: 'home', chapter: 8, lang: 'en', text: world.marsh },
    { key: 'faction', chapter: 19, lang: 'en', text: 'The Lamplighters' },
  ],
} as const;

/** Kinds the home page lists beyond those in the deck, each with one invented example. */
export const moreKinds = [
  { key: 'book', cover: 'book', id: shelf[0].id, name: { lang: 'en', text: shelf[0].title } },
  {
    key: 'software',
    cover: 'package',
    id: '51829304-cfd0-41e2-9354-6f708192a3b4',
    name: { lang: 'en', text: 'Quillmark' },
  },
  {
    key: 'wiki',
    cover: 'document',
    id: '6293a415-d0e1-42f3-a465-708192a3b4c5',
    name: { lang: 'en', text: world.marsh },
  },
  {
    key: 'community',
    cover: null,
    id: lantern.id,
    name: { lang: 'zh-Hant', text: '燈籠書庫讀書會' },
  },
] as const;

export type KindKey = StoryKind | (typeof moreKinds)[number]['key'];
