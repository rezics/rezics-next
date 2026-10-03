import { realmHref, siteHref, realmWorkHref } from '../realm/route.ts';
import { profileHref } from '../profile/route.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type {
  ZoneBrowseEntry,
  ZoneContext,
  ZoneDecision,
  ZoneModule,
  ZoneModuleType,
  ZonePerson,
  ZoneText,
  ZoneTokens,
  ZoneWork,
} from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { browseFacets, parseBrowseState } from './browse-state.ts';
import { browseEntry, type BrowseModel, browseModel, type FacetCounts } from './browse-view.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { presetTokens } from './presentation.ts';
import type { ModuleState, PlacedModule } from './zone-home.tsx';

// Story data for the official Books, Mods and AI Workshop Zones. `rich` is the
// catalogue each Zone is designed for: authors, hooks, serial states, update
// times, genre chips, charts, people and tested models. `seeded` is what the
// local demo's Main serves today (scripts/dev/seed/official-plan.ts): picks,
// the latest shelf, one editors' list and decisions, with no credited authors,
// some Works still without a hook and prompts without tested models, so each
// package is also seen at its thinnest.

export type OfficialSlug = 'books' | 'mods' | 'ai-workshop';
export type Catalogue = 'rich' | 'seeded';

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const zh = (locale: UiLocale) => locale === 'zh-Hans';
const text = (value: string, lang: string): ZoneText => ({ value, lang, dir: 'ltr' });

interface Seed {
  key: string;
  title: string;
  lang: string;
  author?: string;
  tagline?: string;
  taglineLang?: string;
  kind?: ZoneWork['kind'];
  status?: ZoneWork['status'];
  updated?: number;
  chapters?: number;
  /** A published prompt or Skill; `tested` models show in the rich catalogue only, as the demo records none. */
  hub?: { kind: 'prompt' | 'skill'; text: string; description?: string; tested?: string[] };
}

/** A Skill as the seed imports it: one SKILL.md whose front matter carries its description. */
const skill = (name: string, description: string, body: string): NonNullable<Seed['hub']> => ({
  kind: 'skill',
  description,
  text: `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n${body}\n`,
});

/** Main's card excerpt: the first 240 characters of a prompt, or a Skill's description. */
const excerpt = (hub: NonNullable<Seed['hub']>) =>
  Array.from(hub.description ?? hub.text)
    .slice(0, 240)
    .join('');

const realms: Record<OfficialSlug, string> = {
  books: '01a0e4b6-ff6c-7769-a431-6ede0fd85d29',
  mods: '01a0e4b7-01ea-707d-ba1d-59387b1caaf0',
  'ai-workshop': '01a0e4b7-044b-7098-8cda-c96fb7108d49',
};

/** Where a pick's "Why here?" stamp leads: its Decision in the Zone's log. */
export const decisionHref = (slug: OfficialSlug, locale: UiLocale, key: string) =>
  `${realmHref(locale, slug, 'decisions')}#decision-${key}`;

function worksOf(
  slug: OfficialSlug,
  seeds: readonly Seed[],
  locale: UiLocale,
  catalogue: Catalogue,
): ZoneWork[] {
  const offset = { books: 1, mods: 2, 'ai-workshop': 3 }[slug];
  return seeds.map((seed, index) => {
    const id = `00000000-0000-7000-800${offset}-${String(index).padStart(12, '0')}`;
    const rich = catalogue === 'rich';
    return {
      id: `https://rezics.com/id/${id}`,
      href: realmWorkHref(slug, id),
      title: text(seed.title, seed.lang),
      cover: null,
      kind: seed.kind ?? 'document',
      author: rich && seed.author ? text(seed.author, '') : null,
      tagline: seed.tagline ? text(seed.tagline, seed.taglineLang ?? seed.lang) : null,
      // The demo seeds a completion state for its books only.
      status: rich || seed.kind === 'book' ? (seed.status ?? null) : null,
      chapters: rich ? (seed.chapters ?? null) : null,
      words: null,
      updatedAt: rich && seed.updated !== undefined ? daysAgo(seed.updated) : null,
      decision: decisionHref(slug, locale, seed.key),
      // Main names no language for a Hub card's text.
      hub: seed.hub
        ? {
            kind: seed.hub.kind,
            preview: text(excerpt(seed.hub), ''),
            copyText: seed.hub.text,
            testedModels: rich ? (seed.hub.tested ?? []) : [],
          }
        : null,
    };
  });
}

function module<Type extends ZoneModuleType>(
  id: string,
  type: Type,
  title: string,
  options: Partial<Omit<ZoneModule, 'id' | 'type' | 'title'>> = {},
): ZoneModule<Type> {
  return { id, type, title, rail: false, layout: 'covers', shuffle: false, more: null, ...options };
}

const place = <Type extends ZoneModuleType>(
  placed: ZoneModule<Type>,
  data: Extract<ModuleState<Type>, { state: 'ready' }>['data'],
) => ({ module: placed, state: { state: 'ready', data } }) as PlacedModule;

// The seeded Works keep the plan's titles, hooks and gaps; the rich ones add what a full catalogue carries.

const books: readonly (Seed & { seeded?: boolean })[] = [
  {
    key: 'jane-eyre',
    seeded: true,
    title: 'Jane Eyre',
    lang: 'en',
    author: 'Charlotte Brontë',
    kind: 'book',
    status: 'completed',
    tagline:
      'An orphan governess, a house with a locked attic, and a love she will not buy with her freedom.',
  },
  {
    key: 'pride',
    seeded: true,
    title: 'Pride and Prejudice',
    lang: 'en',
    author: 'Jane Austen',
    kind: 'book',
    status: 'completed',
    tagline: 'Elizabeth Bennet meets a proud stranger, and first impressions begin to unravel.',
  },
  {
    key: 'frankenstein',
    seeded: true,
    title: 'Frankenstein; or, The Modern Prometheus',
    lang: 'en',
    author: 'Mary Shelley',
    kind: 'book',
    status: 'completed',
    tagline: 'A young scientist builds a life, then runs from what he made.',
  },
  {
    key: 'little-women',
    seeded: true,
    title: 'Little Women',
    lang: 'en',
    author: 'Louisa May Alcott',
    kind: 'book',
    status: 'completed',
    tagline: 'Four sisters, one hard winter, and the plays they stage to get through it.',
  },
  {
    key: 'secret-garden',
    seeded: true,
    title: 'The Secret Garden',
    lang: 'en',
    author: 'Frances Hodgson Burnett',
    kind: 'book',
    status: 'completed',
    tagline: 'A lonely girl finds a locked garden, and a key, and a reason to stay.',
  },
  {
    key: 'sherlock',
    seeded: true,
    title: 'The Adventures of Sherlock Holmes',
    lang: 'en',
    author: 'Arthur Conan Doyle',
    kind: 'book',
    status: 'completed',
    tagline: 'Twelve cases, one detective, and the woman who outwitted him.',
  },
  {
    key: 'alice',
    seeded: true,
    title: 'Alice’s Adventures in Wonderland',
    lang: 'en',
    author: 'Lewis Carroll',
    kind: 'book',
  },
  {
    key: 'wuthering',
    title: 'Wuthering Heights',
    lang: 'en',
    author: 'Emily Brontë',
    kind: 'book',
    status: 'completed',
    tagline: 'On the moors, a foundling’s love curdles into a revenge that outlives them all.',
  },
  {
    key: 'middlemarch',
    title: 'Middlemarch',
    lang: 'en',
    author: 'George Eliot',
    kind: 'book',
    status: 'completed',
    tagline: 'A provincial town, a dozen ambitions, and the quiet cost of choosing well.',
  },
  {
    key: 'red-chamber',
    title: '红楼梦',
    lang: 'zh-Hans',
    author: '曹雪芹',
    kind: 'book',
    status: 'completed',
    tagline: '大观园里的青春与离散，一部写尽人情世故的长篇。',
  },
  {
    key: 'journey-west',
    title: '西游记',
    lang: 'zh-Hans',
    author: '吴承恩',
    kind: 'book',
    status: 'completed',
    tagline: '一只石猴、一位取经人，十万八千里的修行路。',
  },
  {
    key: 'call-to-arms',
    title: '呐喊',
    lang: 'zh-Hans',
    author: '鲁迅',
    kind: 'book',
    status: 'completed',
    tagline: '十四篇小说，一声想唤醒铁屋中沉睡者的呐喊。',
  },
];

const mods: readonly (Seed & { seeded?: boolean })[] = [
  {
    key: 'lumen-fabric',
    seeded: true,
    title: 'Lumen Lanterns',
    lang: 'en',
    author: 'jun',
    kind: 'package',
    tagline: 'Warm lantern light for Minecraft 1.21.1 on Fabric.',
    status: 'ongoing',
    updated: 1,
  },
  {
    key: 'weaver-forge',
    seeded: true,
    title: 'Chunk Weaver',
    lang: 'en',
    author: 'lattice',
    kind: 'package',
    tagline: 'Prepare nearby Minecraft chunks before you explore on Forge.',
    status: 'ongoing',
    updated: 3,
  },
  {
    key: 'tidy-fabric',
    seeded: true,
    title: 'Tidy Inventory',
    lang: 'en',
    author: 'boxwright',
    kind: 'package',
    tagline: 'Sort chests with one key on Minecraft 1.21.1 with Fabric.',
    status: 'ongoing',
    updated: 9,
  },
  {
    key: 'quiet-forge',
    seeded: true,
    title: 'Quiet Villagers',
    lang: 'en',
    author: '木桶',
    kind: 'package',
    tagline: 'Quieter trading sounds for Minecraft 1.21.1 with Forge.',
    status: 'hiatus',
    updated: 200,
  },
  {
    key: 'shader-guide',
    seeded: true,
    title: 'Minecraft shaders: a gentle first setup',
    lang: 'en',
    author: 'jun',
    tagline: 'Pick one shader pack, tune three settings, keep your frame rate.',
    status: 'ongoing',
    updated: 2,
  },
  {
    key: 'stardew-farm',
    seeded: true,
    title: '星露谷物语 · 春季农场整合包',
    lang: 'zh-Hans',
    author: '阿俊',
    tagline: '二十个模组，一个存档就能用的春季农场。',
    status: 'ongoing',
    updated: 5,
  },
  {
    key: 'mod-guide',
    seeded: true,
    title: 'Mod setup checklist',
    lang: 'en',
    author: 'Mei',
    status: 'completed',
    updated: 40,
  },
  {
    key: 'harvest-ledger',
    title: 'Harvest Ledger',
    lang: 'en',
    author: 'pelican-town',
    kind: 'package',
    status: 'completed',
    updated: 90,
    tagline: 'Every crop, gift and birthday in one quiet overlay.',
  },
  {
    key: 'lantern-roads',
    title: 'Lantern Roads',
    lang: 'en',
    author: 'nightwatch',
    kind: 'package',
    status: 'ongoing',
    updated: 12,
    tagline: 'Lanterns along every road, so night travel feels safe.',
  },
  {
    key: 'crash-doctor',
    title: '崩溃日志五问',
    lang: 'zh-Hans',
    author: '阿俊',
    status: 'completed',
    updated: 20,
    tagline: '五个问题，读懂一份崩溃日志。',
  },
];

const workshop: readonly (Seed & { seeded?: boolean })[] = [
  {
    key: 'club-prompt-v1',
    seeded: true,
    title: 'Book club discussion prompt',
    lang: 'en',
    author: 'Aria',
    tagline: 'Find the questions readers actually disagree about.',
    hub: {
      kind: 'prompt',
      tested: ['claude-sonnet-5', 'gpt-6-luna'],
      text:
        'Read the following book club notes. List three questions the group disagreed on. For each, quote a ' +
        'short phrase from the notes and explain both views. If the notes do not support three disagreements, ' +
        'say how many you found.\n\nNotes: {{notes}}',
    },
  },
  {
    key: 'glossary-prompt-v1',
    seeded: true,
    title: 'Bilingual glossary prompt',
    lang: 'en',
    author: 'Aria',
    tagline: 'Set translation terms before drafting the full text.',
    hub: {
      kind: 'prompt',
      tested: ['claude-sonnet-5'],
      text:
        'Read the source text below. List names and specialist terms with proposed translations before ' +
        'translating. Use each chosen term consistently. At the end, list terms whose meaning remains ' +
        'uncertain.\n\nSource text: {{notes}}',
    },
  },
  {
    key: 'recipe-skill-v1',
    seeded: true,
    title: 'Recipe scaling skill',
    lang: 'en',
    author: 'Aria',
    tagline: 'Scale ingredient amounts and flag judgment calls.',
    hub: skill(
      'recipe-scaling',
      'Scales a recipe to any number of servings and flags what needs tasting.',
      'Ask for the original and desired number of servings. Scale measured ingredients by the ratio. ' +
        'Keep cooking times separate and flag ingredients such as salt and spices for a taste check.',
    ),
  },
  {
    key: 'reading-skill-v1',
    seeded: true,
    title: 'Reading notes skill',
    lang: 'en',
    author: 'Aria',
    tagline: 'Turn reading notes into a short recap and open questions.',
    hub: skill(
      'reading-notes',
      'Groups reading notes by theme, writes a short recap and lists open questions.',
      'Ask for the reader’s notes. Group the notes by theme, write a short recap, and list open ' +
        'questions. Do not add events or quotations absent from the notes.',
    ),
  },
  {
    key: 'no-spoilers',
    title: 'Chapter summary, no spoilers',
    lang: 'en',
    author: 'Theo',
    tagline: 'Summarises up to the chapter you have read, and never a page past it.',
    hub: {
      kind: 'prompt',
      tested: ['claude-opus-5-5'],
      text: 'Summarise the book up to the end of chapter {{chapter}}. Mention nothing that happens later.',
    },
  },
  {
    key: 'citations',
    title: 'Citation checker skill',
    lang: 'en',
    author: 'June',
    tagline: 'Checks each quote against the edition you name and marks the misses.',
    hub: skill(
      'citation-checker',
      'Checks quotations against a named edition.',
      'For each quotation, find it in the named edition and mark any that differ.',
    ),
  },
  {
    key: 'style-mirror',
    title: '文风镜像',
    lang: 'zh-Hans',
    author: '三更灯',
    tagline: '贴一段范文，让模型用同样的语气改写你的段落。',
    hub: {
      kind: 'prompt',
      text: '阅读下面的范文，概括它的语气和句式，再用同样的风格改写我的段落。\n\n范文：{{sample}}\n段落：{{draft}}',
    },
  },
  {
    key: 'club-notes',
    title: 'Book club notes assistant',
    lang: 'en',
    author: 'Aria',
    tagline: 'Turn a messy discussion into three questions for next week.',
  },
];

const catalogues = { books, mods, 'ai-workshop': workshop } as const;

/** The Zone's Works in `locale`: all of them, or only those the demo seeds. */
export function officialWorks(
  slug: OfficialSlug,
  locale: UiLocale,
  catalogue: Catalogue,
): ZoneWork[] {
  const seeds = catalogues[slug].filter((seed) => catalogue === 'rich' || seed.seeded);
  return worksOf(slug, seeds, locale, catalogue);
}

const names: Record<
  OfficialSlug,
  { en: string; 'zh-Hans': string; about: { en: string; 'zh-Hans': string } }
> = {
  books: {
    en: 'Books',
    'zh-Hans': '图书',
    about: {
      en: 'Public-domain classics and the editions worth reading, in English and Chinese.',
      'zh-Hans': '公版经典和值得读的版本，中英文都有。',
    },
  },
  mods: {
    en: 'Mods',
    'zh-Hans': '模组',
    about: {
      en: 'Game mods, load orders and setup guides that keep your saves safe.',
      'zh-Hans': '游戏模组、加载顺序和不会弄坏存档的安装指南。',
    },
  },
  'ai-workshop': {
    en: 'AI Workshop',
    'zh-Hans': 'AI 工作坊',
    about: {
      en: 'Prompts, skills and small tools for reading and writing with AI.',
      'zh-Hans': '用 AI 读书和写作的提示词、技能与小工具。',
    },
  },
};

/** Each official Zone's preset in the demo (scripts/dev/seed/plan.ts). */
export const officialPresets = {
  books: 'editorial',
  mods: 'vibrant',
  'ai-workshop': 'clean',
} as const;

export function officialZone(
  slug: OfficialSlug,
  locale: UiLocale,
  tokens: ZoneTokens = presetTokens[officialPresets[slug]],
): ZoneContext {
  const lang = zh(locale) ? 'zh-Hans' : 'en';
  const home = siteHref(locale, slug, []);
  return {
    slug,
    realm: `https://rezics.com/id/${realms[slug]}`,
    name: text(names[slug][lang], lang),
    description: text(names[slug].about[lang], lang),
    icon: null,
    hero: null,
    tokens,
    locale,
    links: {
      home,
      browse: `${home}/browse`,
      works: `${home}/browse`,
      discussions: realmHref(locale, slug, 'discussions'),
      decisions: realmHref(locale, slug, 'decisions'),
      about: realmHref(locale, slug, 'about'),
    },
  };
}

function decisionsOf(
  slug: OfficialSlug,
  works: readonly ZoneWork[],
  locale: UiLocale,
): ZoneDecision[] {
  const keyOf = (work: ZoneWork) => work.decision!.split('#decision-')[1]!;
  return [
    ...works
      .slice(0, 4)
      .map((work, index) => ({
        id: `${slug}-d${index}`,
        kind: 'adoption' as const,
        outcome: null,
        work,
        href: work.decision!,
        sequence: String(10 - index),
      })),
    {
      id: `${slug}-rule`,
      kind: 'semantic-rule-change',
      outcome: null,
      work: null,
      href: decisionHref(slug, locale, 'rule'),
      sequence: '5',
    },
    {
      id: `${slug}-tag`,
      kind: 'classification',
      outcome: 'accepted',
      work: works[4] ?? works[0]!,
      href: decisionHref(slug, locale, keyOf(works[4] ?? works[0]!)),
      sequence: '4',
    },
  ];
}

type Words = { en: string; 'zh-Hans': string };
const say = (words: Words, locale: UiLocale) => words[zh(locale) ? 'zh-Hans' : 'en'];

const common = {
  featured: { en: 'Featured', 'zh-Hans': '精选' },
  latest: { en: 'Latest', 'zh-Hans': '最新收录' },
  newlyAdded: { en: 'Newly added', 'zh-Hans': '新收录' },
  completed: { en: 'Completed', 'zh-Hans': '完结作品' },
  editors: { en: 'Editors’ picks', 'zh-Hans': '编辑推荐' },
  decisions: { en: 'Recent decisions', 'zh-Hans': '最近的决定' },
};

/**
 * A Zone's modules as its editors lay them out. `seeded` is the demo's layout
 * (picks, latest, one editors' list, decisions); `rich` adds the modules each
 * package is designed around.
 */
export function officialModules(
  slug: OfficialSlug,
  locale: UiLocale,
  catalogue: Catalogue = 'rich',
): PlacedModule[] {
  const works = officialWorks(slug, locale, catalogue);
  const lang = zh(locale) ? 'zh-Hans' : 'en';
  const home = siteHref(locale, slug, []);
  const pick = (...keys: string[]) =>
    keys.flatMap((key) => {
      const work = works.find((candidate) => candidate.decision?.endsWith(`#decision-${key}`));
      return work ? [work] : [];
    });
  const chipNav = (chips: readonly string[]) =>
    place(
      module(
        'games',
        'chip-nav',
        say({ en: 'Games and loaders', 'zh-Hans': '游戏与加载器' }, locale),
      ),
      {
        chips: chips.map((label, index) => ({
          id: `game-${index}`,
          label: text(label, 'en'),
          href: `/${locale}/discover?term=${index}`,
        })),
      },
    );
  const hero = place(module('picks', 'hero-carousel', say(common.featured, locale)), {
    banners: works
      .slice(0, 4)
      .map((work) => ({ id: work.id, title: work.title!, href: work.href, image: null, work })),
  });
  const completed = works.filter((work) => work.status === 'completed');
  const latest = place(
    module('latest', 'shelf', say(common.latest, locale), { more: `${home}/works` }),
    {
      tabs: [
        { id: 'adopted', label: say(common.newlyAdded, locale), items: works.slice(0, 10) },
        ...(completed.length
          ? [
              {
                id: 'completed',
                label: say(common.completed, locale),
                items: completed.slice(0, 10),
              },
            ]
          : []),
      ],
    },
  );
  const lists = {
    books: [
      {
        id: 'start-here',
        title: 'Classics to start with · 从这里开始读经典',
        blurb: {
          en: 'Six novels that reward a first-time reader, in the editions we trust.',
          'zh-Hans': '六部适合第一次读经典的小说，附上我们信得过的版本。',
        },
        keys: ['pride', 'jane-eyre', 'little-women', 'secret-garden', 'alice', 'frankenstein'],
      },
    ],
    mods: [
      {
        id: 'first-mods',
        title: 'First mods · 第一次装模组',
        blurb: {
          en: 'Start here: four mods that are hard to break and easy to undo.',
          'zh-Hans': '从这里开始：四个不容易出错、也容易撤回的模组。',
        },
        keys: ['lumen-fabric', 'weaver-forge', 'tidy-fabric', 'quiet-forge'],
      },
    ],
    'ai-workshop': [
      {
        id: 'reading-prompts',
        title: 'Prompts for readers · 读书人的提示词',
        blurb: {
          en: 'For book clubs, bilingual reading and notes you will actually reread.',
          'zh-Hans': '给读书会、双语阅读和真正会回看的笔记。',
        },
        keys: ['club-prompt-v1', 'reading-skill-v1', 'no-spoilers', 'club-notes'],
      },
      {
        id: 'writing-prompts',
        title: 'Writing and translation · 写作与翻译',
        blurb: {
          en: 'Keep terms straight, match a voice and check every quote.',
          'zh-Hans': '统一译名、模仿文风，核对每一处引文。',
        },
        keys: ['glossary-prompt-v1', 'recipe-skill-v1', 'citations', 'style-mirror'],
      },
    ],
  }[slug];
  const editors = place(
    module('editors', 'editorial-list', say(common.editors, locale), { layout: 'rows' }),
    {
      lists: lists
        .map((list) => ({
          id: list.id,
          title: text(list.title, 'en'),
          blurb: catalogue === 'rich' ? text(say(list.blurb, locale), lang) : null,
          href: null,
          items: pick(...list.keys),
        }))
        .filter((list) => list.items.length),
    },
  );
  const decisions = place(
    module('decisions', 'decision-log', say(common.decisions, locale), {
      rail: true,
      more: realmHref(locale, slug, 'decisions'),
    }),
    { items: decisionsOf(slug, works, locale) },
  );
  if (catalogue === 'seeded') return [hero, latest, editors, decisions];
  if (slug === 'books')
    return [
      hero,
      latest,
      editors,
      place(
        module(
          'authors',
          'people',
          say({ en: 'Authors to follow', 'zh-Hans': '值得关注的作者' }, locale),
          { rail: true },
        ),
        { items: bookPeople(locale) },
      ),
      decisions,
    ];
  if (slug === 'mods') {
    return [
      hero,
      chipNav([
        'Minecraft',
        'Stardew Valley',
        'Skyrim SE',
        'Terraria',
        'Fabric',
        'NeoForge',
        'SMAPI',
      ]),
      place(
        module('trending', 'ranking', say({ en: 'Trending', 'zh-Hans': '热门趋势' }, locale), {
          more: `${home}/works`,
        }),
        {
          metric: 'reads',
          tabs: (['day', 'week', 'month'] as const).map((interval, shift) => ({
            interval,
            items: [...works.slice(shift), ...works.slice(0, shift)]
              .slice(0, 8)
              .map((work, index) => ({ rank: index + 1, work })),
          })),
        },
      ),
      latest,
      editors,
      decisions,
    ];
  }
  return [hero, latest, editors, decisions];
}

function bookPeople(locale: UiLocale): ZonePerson[] {
  const lang = zh(locale) ? 'zh-Hans' : 'en';
  const person = (id: string, name: string, nameLang: string, note: Words): ZonePerson => ({
    id,
    href: localizedPath(profileHref(id), locale),
    name: text(name, nameLang),
    avatar: null,
    note: text(note[lang], lang),
  });
  return [
    person('charlotte-bronte', 'Charlotte Brontë', 'en', {
      en: 'Jane Eyre, Villette. Wrote as Currer Bell until 1848.',
      'zh-Hans': '《简·爱》《维莱特》。1848 年前以柯勒·贝尔为笔名。',
    }),
    person('lu-xun', '鲁迅', 'zh-Hans', {
      en: 'Call to Arms, Wandering. The father of modern Chinese fiction.',
      'zh-Hans': '《呐喊》《彷徨》。中国现代小说的开创者。',
    }),
    person('jane-austen', 'Jane Austen', 'en', {
      en: 'Six novels of manners, every one still in print.',
      'zh-Hans': '六部世情小说，至今本本再版。',
    }),
    person('mary-shelley', 'Mary Shelley', 'en', {
      en: 'Began Frankenstein at nineteen, on a dare.',
      'zh-Hans': '十九岁时因一场打赌写下《弗兰肯斯坦》。',
    }),
  ];
}

const typeOf = {
  book: 'https://schema.org/Book',
  document: 'https://schema.org/DigitalDocument',
  recipe: 'https://schema.org/Recipe',
  package: 'https://rezics.com/vocab/ModPackage',
  game: 'https://schema.org/VideoGame',
} as const;

/** What Main's browse read would match for each Facet value among `works`, most common first. */
export function browseCounts(works: readonly ZoneWork[]): FacetCounts {
  const tally = (values: (work: ZoneWork) => readonly string[]) => {
    const found = new Map<string, number>();
    for (const work of works)
      for (const value of new Set(values(work))) found.set(value, (found.get(value) ?? 0) + 1);
    return [...found]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };
  return {
    concept: [],
    status: tally((work) => (work.status ? [work.status] : [])),
    length: [],
    type: tally((work) => [typeOf[work.kind]]),
  };
}

/** The search and filters an official Zone's home leads with. */
export function officialBrowse(
  slug: OfficialSlug,
  locale: UiLocale,
  catalogue: Catalogue = 'rich',
): ZoneBrowseEntry {
  return browseEntry({
    base: siteHref(locale, slug, ['browse']),
    zoneName: officialZone(slug, locale).name.value,
    counts: browseCounts(officialWorks(slug, locale, catalogue)),
    locale,
    messages: zoneMessagesFor(locale),
  });
}

/** An official Zone's browse page for URL parameters, filtered as Main filters its window. */
export function officialBrowseModel(
  slug: OfficialSlug,
  locale: UiLocale,
  params: Record<string, string | string[]> = {},
  catalogue: Catalogue = 'rich',
): BrowseModel {
  const state = parseBrowseState(params);
  const works = officialWorks(slug, locale, catalogue);
  const holds = (work: ZoneWork, except?: string) =>
    Object.entries(state.filter).every(
      ([facet, values]) =>
        facet === except ||
        values.some(
          (value) =>
            (
              ({
                status: () => work.status === value,
                type: () => typeOf[work.kind] === value,
                concept: () => false,
                length: () => false,
              }) as Record<string, () => boolean | undefined>
            )[facet]?.() ?? false,
        ),
    );
  const found = works.filter(
    (work) =>
      holds(work) &&
      (!state.text || work.title?.value.toLowerCase().includes(state.text.toLowerCase())),
  );
  const all = browseCounts(works.filter((work) => holds(work)));
  // Each Facet counts with the other Facets' Conditions only, as Main's do.
  const facets = Object.fromEntries(
    Object.keys(all).map((facet) => [
      facet,
      browseCounts(works.filter((work) => holds(work, facet)))[facet as keyof FacetCounts],
    ]),
  ) as FacetCounts;
  // Main retains a chosen zero-count value so the reader can see and remove it.
  for (const facet of browseFacets) {
    facets[facet] = [
      ...facets[facet],
      ...(state.filter[facet] ?? [])
        .filter((value) => !facets[facet].some((item) => item.value === value))
        .map((value) => ({ value, count: 0 })),
    ];
  }
  return browseModel({
    base: siteHref(locale, slug, ['browse']),
    zoneName: officialZone(slug, locale).name.value,
    state,
    admitted: new Map([
      ['type', zh(locale) ? '种类' : 'Type'],
      ['concept', zh(locale) ? '标签' : 'Tags'],
    ]),
    locale,
    messages: zoneMessagesFor(locale),
    page: {
      items: found.slice(0, 20),
      facets,
      matches: { value: found.length, kind: 'exact' },
      window: { scanned: works.length, complete: true },
      tags: 'current',
      nextCursor: null,
      sort: state.sort ?? (state.text ? 'relevance' : 'newest'),
    },
  });
}
