export interface DemoPerson { id: string; name: string; seedName?: string; handle: string; email: string; password: string }
export interface DemoWork { id: string; title: string; type: 'book' | 'document' | 'recipe' | 'prompt' | 'skill' | 'mod';
  seedTitle?: string;
  language: 'en' | 'zh-Hans'; excerpt?: string; tagline?: string;
  completionStatus?: 'ongoing' | 'completed' | 'hiatus';
  author?: 'mei' | 'daniel' | 'an' | 'sophie' | 'jun' | 'aria' | 'leo' | 'moonlight';
  /** A Book's chapters in reading order. Each is made by Studio's chapter command as a part of the Book, never
   * as a Work of its own in this list: catalogues, search and shelves show the Book. */
  chapters?: readonly { title: string; body: string }[] }

export const people: readonly DemoPerson[] = [
  { id: 'mei', handle: 'lin_mei', name: '林梅', seedName: 'Lin Mei 林梅', email: 'rezics-demo-mei@example.test', password: 'Rezics-demo-2026-mei' },
  { id: 'daniel', handle: 'daniel_chen', name: 'Daniel Chen', seedName: 'Daniel Chen 陈丹尼', email: 'rezics-demo-daniel@example.test', password: 'Rezics-demo-2026-daniel' },
  { id: 'an', handle: 'an_wu', name: '吴安', seedName: 'An Wu 吴安', email: 'rezics-demo-an@example.test', password: 'Rezics-demo-2026-an' },
  { id: 'sophie', handle: 'sophie_li', name: 'Sophie Li', seedName: 'Sophie Li 李素菲', email: 'rezics-demo-sophie@example.test', password: 'Rezics-demo-2026-sophie' },
  { id: 'jun', handle: 'jun_zhang', name: '张俊', seedName: 'Jun Zhang 张俊', email: 'rezics-demo-jun@example.test', password: 'Rezics-demo-2026-jun' },
  { id: 'aria', handle: 'aria_wang', name: 'Aria Wang', seedName: 'Aria Wang 王雅', email: 'rezics-demo-aria@example.test', password: 'Rezics-demo-2026-aria' },
  { id: 'leo', handle: 'leo_sun', name: '孙乐', seedName: 'Leo Sun 孙乐', email: 'rezics-demo-leo@example.test', password: 'Rezics-demo-2026-leo' },
  { id: 'mira', handle: 'mira_park', name: 'Mira Park', seedName: 'Mira Park 朴美罗', email: 'rezics-demo-mira@example.test', password: 'Rezics-demo-2026-mira' },
];

export const works: readonly DemoWork[] = [
  { id: 'pride', title: 'Pride and Prejudice', type: 'book', language: 'en',
    tagline: 'Elizabeth Bennet meets a proud stranger, and first impressions begin to unravel.',
    completionStatus: 'completed' },
  { id: 'alice', title: "Alice's Adventures in Wonderland", type: 'book', language: 'en' },
  { id: 'sherlock', title: 'The Adventures of Sherlock Holmes', type: 'book', language: 'en' },
  { id: 'sherlock-scandal', title: 'A Scandal in Bohemia', type: 'document', language: 'en' },
  { id: 'jane-eyre', title: 'Jane Eyre', type: 'book', language: 'en' },
  { id: 'frankenstein', title: 'Frankenstein; or, The Modern Prometheus', type: 'book', language: 'en' },
  { id: 'little-women', title: 'Little Women', type: 'book', language: 'en' },
  { id: 'secret-garden', title: 'The Secret Garden', type: 'book', language: 'en' },
  { id: 'journey-west', title: '西游记', type: 'book', language: 'zh-Hans',
    tagline: '一场西行取经之旅，从石猴出世开始。', completionStatus: 'completed' },
  { id: 'red-chamber', title: '红楼梦', type: 'book', language: 'zh-Hans' },
  { id: 'strange-tales', title: '聊斋志异', type: 'book', language: 'zh-Hans' },
  { id: 'painted-skin', title: '画皮', type: 'document', language: 'zh-Hans' },
  { id: 'three-kingdoms', title: '三国演义', type: 'book', language: 'zh-Hans' },
  { id: 'water-margin', title: '水浒传', type: 'book', language: 'zh-Hans' },
  { id: 'serial', title: '雨夜书店', seedTitle: '雨夜书店 · 连载小说', type: 'book', language: 'zh-Hans', author: 'mei',
    tagline: '一封没有地址的信，把雨夜书店带向二十年前的秘密。', completionStatus: 'ongoing',
    excerpt: '第一章 雨夜\n雨停在书店打烊前。林梅在门口发现一封没有地址的信。',
    chapters: [
      { title: '第一章 雨夜', body: '雨停在书店打烊前。林梅在门口发现一封没有地址的信。' },
      { title: '第二章 未寄出的信', body: '信封里只有一张旧车票，日期是二十年前。' },
      { title: '第三章 最后一班车', body: '末班车到站时，整座站台只有她一个人。' },
    ] },
  { id: 'moonlight-story', title: '夜归人', seedTitle: '月下书生 · 夜归人', type: 'book', language: 'zh-Hans', author: 'moonlight',
    tagline: '雨停以后，归来的人敲开了旧书店的门。', completionStatus: 'ongoing',
    excerpt: '第一章 夜归人\n雨停以后，有人敲响了旧书店的门。' },
  { id: 'bun', title: 'Bun', seedTitle: 'Bun — JavaScript runtime', type: 'document', language: 'en', author: 'daniel',
    excerpt: 'Bun is a JavaScript runtime. Start with a small script, then compare its tooling with the needs of your project.' },
  { id: 'elysia', title: 'Elysia', seedTitle: 'Elysia — TypeScript web framework', type: 'document', language: 'en', author: 'daniel',
    excerpt: 'Elysia provides a way to define HTTP routes with TypeScript. Check the request and response contract before adding a handler.' },
  { id: 'react', title: 'React', seedTitle: 'React — user interface library', type: 'document', language: 'en', author: 'sophie',
    excerpt: 'React builds interfaces from components. A small component is a useful place to test states and keyboard behavior.' },
  { id: 'typescript', title: 'TypeScript', seedTitle: 'TypeScript — typed JavaScript', type: 'document', language: 'en', author: 'daniel',
    excerpt: 'TypeScript adds static types to JavaScript. Describe the data shape at an API boundary, then check callers against it.' },
  { id: 'dumplings', title: '韭菜鸡蛋饺子', type: 'recipe', language: 'zh-Hans', author: 'an' },
  { id: 'noodles', title: '番茄鸡蛋面', type: 'recipe', language: 'zh-Hans', author: 'an' },
  { id: 'pancakes', title: 'Weekend buttermilk pancakes', type: 'recipe', language: 'en', author: 'aria' },
  { id: 'tea', title: 'Ginger lemon tea', type: 'recipe', language: 'en', author: 'aria' },
  { id: 'prompt', title: 'Bilingual book club discussion prompt', type: 'prompt', language: 'en', author: 'mei',
    excerpt: 'Ask each reader to choose one passage, explain its meaning in their preferred language, and compare interpretations.' },
  { id: 'skill', title: 'Recipe scaling assistant skill', type: 'skill', language: 'en', author: 'mei',
    excerpt: 'Ask for the original servings and the desired servings. Show the new quantities and flag ingredients that need judgment.' },
  { id: 'mod-guide', title: 'Mod setup checklist', type: 'document', language: 'en', author: 'mei',
    excerpt: 'Record the game version, required dependencies, load order, and a way to restore the previous setup before changing mods.' },
  // Other people's mods, so Lumen Lanterns (Jun's) can name co-readers of the same kind.
  { id: 'camp-lanterns', title: 'Camp Lanterns', type: 'mod', language: 'en', author: 'sophie',
    excerpt: 'Hang warm lanterns around a campsite. Place one, light it, and keep a spare in the chest.' },
  { id: 'trail-markers', title: 'Trail Markers', type: 'mod', language: 'en', author: 'leo',
    excerpt: 'Leave a visible marker where a path splits. Markers stay until the player who placed them picks them up.' },
];

export const realms = [
  { id: 'fiction', name: 'Fiction', seedName: 'Fiction · 小说', preset: 'serial',
    featured: ['serial', 'journey-west', 'red-chamber'] },
  { id: 'books', name: 'Books', seedName: 'Books · 图书', preset: 'editorial',
    featured: ['pride', 'alice', 'jane-eyre', 'little-women'] },
  { id: 'mods', handle: 'game-mods', name: 'Mods', seedName: 'Mods · 模组', preset: 'vibrant',
    featured: ['mod-guide'] },
  { id: 'ai-workshop', name: 'AI Workshop', seedName: 'AI Workshop · AI 工作坊', preset: 'clean',
    featured: ['prompt', 'skill'] },
  { id: 'software', name: 'Software', seedName: 'Software · 软件', preset: 'clean',
    featured: ['bun', 'elysia', 'react', 'typescript'] },
  { id: 'kitchen', name: 'Kitchen', seedName: 'Kitchen · 厨房', preset: 'editorial',
    featured: ['dumplings', 'noodles', 'pancakes', 'tea'] },
  { id: 'games', name: 'Games', seedName: 'Games · 游戏', preset: 'vibrant', featured: [] },
] as const;

/** Agents the first demo person also controls: a pen name and an organization. */
export const penNames = [
  { id: 'moonlight', displayName: '月下书生', seedName: '月下书生 · Moonlit Scribe',
    localizedName: null, kind: 'person' },
  { id: 'northstar', displayName: 'North Star Editions', seedName: 'North Star Editions · 北辰出版',
    localizedName: { original: 'en', labels: { en: 'North Star Editions', 'zh-Hans': '北辰出版' } },
    kind: 'organization' },
] as const;

/**
 * Profile pages (`/@handle`): who is credited on which Works, bios, and whose
 * shelves are public. Only Works with a published text are public, so only
 * those appear. Lin Mei (`people[0]`) is an author whose own shelves stay
 * private; Daniel reads in public.
 */
export const profilePlan = {
  credits: [
    ...works.filter(work => work.author && work.author !== 'moonlight')
      .map(work => ({ agent: work.author!, work: work.id, role: 'author' as const })),
    ...['pride', 'alice'].map(work => ({ agent: 'northstar', work, role: 'editor' })),
    // The web serial the releases step makes. One made before Works named their author has no credit; a new one has it.
    { agent: 'mei', work: 'star-harbor', role: 'author' },
  ] as ReadonlyArray<{ agent: string; work: string; role: 'author' | 'translator' | 'editor' }>,
  bios: [
    { agent: 'mei', language: 'en', text: 'Lin Mei writes 雨夜书店 (The Rainy Night Bookshop), a serial about '
      + 'a bookshop that only opens when it rains, and short guides for book clubs and tinkerers. '
      + 'She reads Austen in two languages.' },
    { agent: 'moonlight', language: 'zh-Hans', text: '月下书生是林梅的笔名。写志怪、旧梦和夜里的书店，'
      + '偶尔重讲《聊斋》里的故事。' },
    { agent: 'northstar', language: 'en', text: 'North Star Editions edits public-domain classics '
      + 'for readers of English and Chinese, with notes on the text and its history.' },
  ],
  libraries: [
    { person: 'daniel', visibility: 'public', shelf: [
      { work: 'serial', status: 'reading' }, { work: 'pride', status: 'read' },
      { work: 'journey-west', status: 'read' }, { work: 'bun', status: 'read' }, { work: 'prompt', status: 'read' },
      { work: 'red-chamber', status: 'want-to-read' }, { work: 'typescript', status: 'want-to-read' }] },
  ] as ReadonlyArray<{ person: string; visibility: 'public';
    shelf: ReadonlyArray<{ work: string; status: 'want-to-read' | 'reading' | 'read' }> }>,
  /** Readers who follow each profile, so follower counts are not all zero. */
  followers: [
    { agent: 'mei', by: ['an', 'sophie', 'jun', 'aria'] },
    { agent: 'moonlight', by: ['daniel', 'leo'] },
  ],
};

export function seedKey(kind: string, id: string): string {
  return `dev-seed:v1:${kind}:${id}`;
}

/** Keep authored bilingual fixture text while publishing canonical language tags. */
export function localizedBilingual(value: { en: string; 'zh-CN': string }, original: 'en' | 'zh-Hans' = 'en') {
  return { original, labels: { en: value.en, 'zh-Hans': value['zh-CN'] } };
}

const typeIris = { book: 'https://schema.org/Book', document: 'https://schema.org/DigitalDocument',
  recipe: 'https://schema.org/Recipe', prompt: 'https://rezics.com/vocab/PromptTemplate',
  skill: 'https://rezics.com/vocab/SkillPackage', mod: 'https://rezics.com/vocab/ModPackage' } as const satisfies Record<DemoWork['type'], string>;

export function semanticTypes(type: DemoWork['type']): string[] {
  return [typeIris[type]];
}

/** The types the first demo seeds recorded: prompts and skills were plain documents then. */
export function firstSeedTypes(type: DemoWork['type']): string[] {
  return semanticTypes(type === 'prompt' || type === 'skill' ? 'document' : type);
}

/**
 * The pages each official Zone mounts in its navigation, through the API: a document (a Work whose published text
 * is the page) and a Collection of every public Work the seed made, so the page has more than one screen.
 */
export const zoneSites = {
  books: {
    guide: { segment: 'guide', title: 'A reader’s guide to REZICS Books', language: 'en' as const,
      text: 'Start here\nBooks holds the classics that are free to read. Open a work, read it chapter by chapter, '
        + 'and rate it as you go; the community’s decisions explain why each one is here.\n'
        + 'Picks\nThe picks page lists more works than the front page can show. Follow it a page at a time.' },
    picks: { segment: 'picks', name: 'More to read', limit: 30 },
  },
} as const;
