import { realmHref, siteHref, realmWorkHref } from '../realm/route.ts';
import type {
  RankingInterval,
  ZoneBanner,
  ZoneContext,
  ZoneDecision,
  ZoneImage,
  ZoneModule,
  ZoneModuleType,
  ZoneTokens,
  ZoneWork,
} from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { messages, type ZoneMessages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { presetTokens } from './presentation.ts';
import type { ModuleState, PlacedModule } from './zone-home.tsx';

// Story data: an invented web-fiction catalogue for the official Fiction
// Zone and a small community Realm. Works carry no cover image, so they wear
// the catalogue's generated covers; banners are generated art.

function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1)
    value = Math.imul(value ^ seed.charCodeAt(index), 0x01000193);
  return value >>> 0;
}

const skies = [
  ['#1d2b53', '#f7a072'],
  ['#0f3d3e', '#e3c16f'],
  ['#3a1c5c', '#f28fad'],
  ['#12263a', '#8fc1e3'],
  ['#5b1a2a', '#f6c28b'],
  ['#203a2b', '#c8e3a4'],
  ['#2d2a4a', '#ffd6a5'],
  ['#402218', '#f2b880'],
] as const;

const svg = (body: string, width: number, height: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`)}`;

function escape(text: string) {
  return text.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
  );
}

/** A wide art-directed banner, as an official Zone's editors would upload. */
function bannerArt(seed: string, headline: string, sub: string): ZoneImage {
  const [top, glow] = skies[hash(seed) % skies.length]!;
  return {
    width: 1200,
    height: 630,
    url: svg(
      `<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${glow}"/></linearGradient></defs><rect width="1200" height="630" fill="url(#b)"/><circle cx="930" cy="250" r="190" fill="#fff" opacity=".12"/><circle cx="1010" cy="330" r="120" fill="#fff" opacity=".12"/><text x="90" y="300" font-family="Songti SC, Noto Serif CJK SC, Georgia, serif" font-weight="700" font-size="96" fill="#fff">${escape(headline)}</text><text x="94" y="380" font-family="PingFang SC, Noto Sans CJK SC, sans-serif" font-size="38" fill="#fff" opacity=".85">${escape(sub)}</text>`,
      1200,
      630,
    ),
  };
}

/** The Zone catalog a story renders in `locale`: English with its translation over it. */
export const zoneMessagesFor = (locale: UiLocale): ZoneMessages =>
  locale === 'zh-Hans' ? { ...messages, ...zhHans } : messages;

const text = (value: string, lang = 'zh-Hans') => ({ value, lang, dir: 'ltr' as const });
const realmId = '01a0e3d0-dca8-7736-a626-f53097e68dce';
const ref = 'fiction';

interface Seed {
  key: string;
  title: string;
  author: string;
  tagline: string;
  lang?: string;
  status?: ZoneWork['status'];
  chapters?: number;
  words?: number;
}

const seeds: Seed[] = [
  {
    key: 'rain',
    title: '雨夜书店',
    author: '林梅',
    tagline: '打烊前的一封无名信，把她带回二十年前的末班车。',
    chapters: 212,
    words: 684000,
  },
  {
    key: 'inn',
    title: '星河旅店',
    author: '北岛听风',
    tagline: '宇宙尽头的旅店只收一种房费：一个没说出口的秘密。',
    chapters: 96,
  },
  {
    key: 'tea',
    title: '剑与茶',
    author: '苏九',
    tagline: '退隐的剑客开了间茶馆，来喝茶的全是当年的仇家。',
    status: 'completed',
    chapters: 340,
  },
  {
    key: 'cat',
    title: '猫咖的第七位客人',
    author: '橘子汽水',
    tagline: '每晚十一点，总有一位客人点一杯不存在的咖啡。',
    chapters: 58,
  },
  {
    key: 'moon',
    title: '月下签语',
    author: '白夜行舟',
    tagline: '抽中下下签的少女，决定改写整座城的命运。',
    chapters: 147,
  },
  {
    key: 'shop',
    title: '我在异世界开书店',
    author: '纸上飞鱼',
    tagline: '魔王想买一本《如何被勇者打败》，我只好现写。',
    chapters: 421,
  },
  {
    key: 'light',
    title: '灯塔守望者',
    author: '陈小渔',
    tagline: '海雾里的灯塔每闪一次，就有一段记忆回到岸上。',
    status: 'completed',
    chapters: 88,
  },
  {
    key: 'crane',
    title: '纸鹤与雷雨',
    author: '三更灯',
    tagline: '他们用纸鹤传信，直到其中一只飞进了雷雨云。',
    chapters: 64,
  },
  {
    key: 'chef',
    title: '深夜食堂的魔法师',
    author: '墨北',
    tagline: '用一碗面治好失眠的人，是这座城最后的魔法师。',
    chapters: 133,
  },
  {
    key: 'taoist',
    title: '玄门小道士',
    author: '夜航船',
    tagline: '下山第一天，小道士就被城隍爷拉去查一桩旧案。',
    chapters: 508,
  },
  {
    key: 'metro',
    title: '末班地铁',
    author: '林梅',
    tagline: '末班地铁多出一站，站名是她童年的家。',
    status: 'hiatus',
    chapters: 37,
  },
  {
    key: 'heron',
    title: '白鹭洲',
    author: '苏九',
    tagline: '一部写给江南水乡的长信，从外婆的渡船说起。',
    status: 'completed',
    chapters: 72,
  },
  {
    key: 'candy',
    title: '糖果屋侦探社',
    author: '橘子汽水',
    tagline: '委托费是一颗糖，案子却一桩比一桩离奇。',
    chapters: 180,
  },
  {
    key: 'bell',
    title: '燃烧的钟楼',
    author: '北岛听风',
    tagline: '钟楼每烧一次，时间就往回退一天。',
    chapters: 45,
  },
  {
    key: 'tides',
    title: 'The Cartographer of Tides',
    author: 'Maren Osei',
    lang: 'en',
    tagline: 'A surveyor maps a delta that redraws itself every full moon.',
    chapters: 41,
  },
  {
    key: 'salt',
    title: 'Salt and Starlight',
    author: 'June Hartley',
    lang: 'en',
    tagline: 'Two rival lighthouse keepers, one storm, and a letter neither will send.',
    status: 'completed',
    chapters: 30,
  },
  {
    key: 'ferry',
    title: 'The Night Ferry Library',
    author: 'Theo Arkwright',
    lang: 'en',
    tagline: 'Books borrowed on the midnight ferry must be returned before dawn.',
    chapters: 22,
  },
  {
    key: 'bone',
    title: '龙骨山守墓人',
    author: '夜航船',
    tagline: '守墓人的规矩只有一条：月圆之夜，别回头。',
    chapters: 256,
  },
  {
    key: 'cloud',
    title: '云端书简',
    author: '三更灯',
    tagline: '寄往云端的信，总会在第二年春天收到回音。',
    chapters: 19,
  },
];

const decisionOf = (key: string) => `${realmHref('en', ref, 'decisions')}#decision-${key}`;

export const works: ZoneWork[] = seeds.map((seed, index) => ({
  id: `https://rezics.com/id/00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
  href: realmWorkHref(ref, `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`),
  title: text(seed.title, seed.lang),
  author: text(seed.author, seed.lang),
  tagline: text(seed.tagline, seed.lang),
  cover: null,
  kind: 'book',
  status: seed.status ?? 'ongoing',
  chapters: seed.chapters ?? null,
  words: seed.words ?? null,
  updatedAt: '2026-09-27T12:00:00.000Z',
  decision: decisionOf(seed.key),
}));

const byKey = (key: string) => works[seeds.findIndex((seed) => seed.key === key)]!;
const pick = (...keys: string[]) => keys.map(byKey);

type Titles = Record<
  | 'picks'
  | 'genres'
  | 'announcement'
  | 'latest'
  | 'newChapters'
  | 'newlyAdded'
  | 'completed'
  | 'mustRead'
  | 'rankings'
  | 'lists'
  | 'quotes'
  | 'rising'
  | 'decisions'
  | 'people'
  | 'discussions',
  string
>;

const titles: Record<'en' | 'zh-Hans', Titles> = {
  en: {
    picks: 'Featured',
    genres: 'Genres',
    announcement: 'Autumn serial contest: shortlist announced — read the ten finalists',
    latest: 'Latest',
    newChapters: 'New chapters',
    newlyAdded: 'Newly added',
    completed: 'Completed',
    mustRead: 'Can’t-miss picks (✧∇✧)',
    rankings: 'Charts',
    lists: 'Editors’ lists',
    quotes: 'Fresh from readers',
    rising: 'New and rising',
    decisions: 'Recent decisions',
    people: 'Authors to follow',
    discussions: 'Talked about',
  },
  'zh-Hans': {
    picks: '精选',
    genres: '分类',
    announcement: '秋季连载征文入围名单公布：十部决选作品抢先读',
    latest: '最新作品',
    newChapters: '最新章节',
    newlyAdded: '新收录',
    completed: '完结作品',
    mustRead: '不可错过的赞赞作品(✧∇✧)',
    rankings: '热门排行',
    lists: '编辑推荐',
    quotes: '新鲜书评',
    rising: '潜力新作',
    decisions: '最近的决定',
    people: '作者推荐',
    discussions: '热议中',
  },
};

export const titlesFor = (locale: UiLocale): Titles =>
  titles[locale === 'zh-Hans' ? 'zh-Hans' : 'en'];

function module<Type extends ZoneModuleType>(
  id: string,
  type: Type,
  title: string,
  options: Partial<Omit<ZoneModule, 'id' | 'type' | 'title'>> = {},
): ZoneModule<Type> {
  return { id, type, title, rail: false, layout: 'covers', shuffle: false, more: null, ...options };
}

const ready = <Type extends ZoneModuleType>(
  data: Extract<ModuleState<Type>, { state: 'ready' }>['data'],
) => ({ state: 'ready', data }) as ModuleState<Type>;

const place = <Type extends ZoneModuleType>(
  placedModule: ZoneModule<Type>,
  state: ModuleState<Type>,
) => ({ module: placedModule, state }) as PlacedModule;

const genres = {
  en: [
    'Urban',
    'Fantasy',
    'Xianxia',
    'Mystery',
    'Sci-fi',
    'Romance',
    'Light novels',
    'Historical',
    'Horror',
    'Fan fiction',
  ],
  'zh-Hans': ['都市', '奇幻', '仙侠', '悬疑', '科幻', '言情', '轻小说', '历史', '灵异', '同人'],
};

const rotations: Record<RankingInterval, string[]> = {
  day: ['shop', 'rain', 'taoist', 'candy', 'inn', 'moon', 'chef', 'tides', 'bell', 'crane'],
  week: ['taoist', 'shop', 'rain', 'tea', 'moon', 'candy', 'inn', 'light', 'salt', 'chef'],
  month: ['tea', 'taoist', 'rain', 'shop', 'heron', 'light', 'moon', 'candy', 'salt', 'inn'],
};

export const banners: ZoneBanner[] = [
  {
    id: 'contest',
    title: text('秋季连载征文 · 决选十强'),
    kicker: text('征文活动'),
    href: realmHref('en', 'fiction', 'about'),
    image: bannerArt('contest', '秋季连载征文', '决选十强 · 抢先读'),
  },
  {
    id: 'rain-launch',
    title: text('《雨夜书店》第二卷开更'),
    kicker: text('新卷上线'),
    href: byKey('rain').href,
    image: bannerArt('rain', '雨夜书店 · 第二卷', '末班车之后，她终于读到那封信'),
  },
  {
    id: 'translations',
    title: text('Translations week: five serials, now in English', 'en'),
    kicker: text('Imprint', 'en'),
    href: siteHref('en', 'fiction', ['browse']),
    image: bannerArt('tides', 'Translations', 'Five serials, now in English'),
  },
];

export const decisions: ZoneDecision[] = [
  {
    id: 'd1',
    kind: 'adoption',
    outcome: null,
    work: byKey('cloud'),
    href: decisionOf('cloud'),
    sequence: '6',
  },
  {
    id: 'd2',
    kind: 'adoption',
    outcome: null,
    work: byKey('bone'),
    href: decisionOf('bone'),
    sequence: '5',
  },
  {
    id: 'd3',
    kind: 'classification',
    outcome: 'accepted',
    work: byKey('shop'),
    href: decisionOf('shop'),
    sequence: '4',
  },
  {
    id: 'd4',
    kind: 'semantic-rule-change',
    outcome: null,
    work: null,
    href: decisionOf('rule'),
    sequence: '3',
  },
  {
    id: 'd5',
    kind: 'classification',
    outcome: 'rejected',
    work: byKey('tea'),
    href: decisionOf('tea'),
    sequence: '2',
  },
  {
    id: 'd6',
    kind: 'adoption',
    outcome: null,
    work: byKey('ferry'),
    href: decisionOf('ferry'),
    sequence: '1',
  },
];

/** The Fiction Zone's presentation with every module filled, as its editors would lay it out. */
export function fictionModules(locale: UiLocale): PlacedModule[] {
  const t = titlesFor(locale);
  const chip = genres[locale === 'zh-Hans' ? 'zh-Hans' : 'en'];
  const withChapters = pick(
    'rain',
    'taoist',
    'shop',
    'candy',
    'moon',
    'chef',
    'inn',
    'crane',
    'bell',
    'tides',
  ).map((work, index) => ({
    ...work,
    latestChapter: {
      title: text(`第 ${(work.chapters ?? 10) - index} 章`),
      href: `${work.href}#latest`,
      at: null,
    },
  }));
  return [
    // Art-directed banners; a Zone without them gets picks instead (communityModules), never both.
    place(module('hero', 'hero-carousel', t.picks), ready<'hero-carousel'>({ banners })),
    place(
      module('genres', 'chip-nav', t.genres),
      ready<'chip-nav'>({
        chips: chip.map((label, index) => ({
          id: `g${index}`,
          label: text(label, locale === 'zh-Hans' ? 'zh-Hans' : 'en'),
          href: `/en/discover?term=${index}`,
        })),
      }),
    ),
    place(
      module('notice', 'announcement', t.announcement),
      ready<'announcement'>({
        text: text(t.announcement, locale === 'zh-Hans' ? 'zh-Hans' : 'en'),
        href: realmHref('en', 'fiction', 'about'),
      }),
    ),
    place(
      module('must-read', 'shelf', t.mustRead, {
        shuffle: true,
        more: siteHref('en', 'fiction', ['browse']),
      }),
      ready<'shelf'>({
        tabs: [
          {
            id: 'picks',
            label: t.mustRead,
            items: pick(
              'inn',
              'tea',
              'cat',
              'moon',
              'shop',
              'light',
              'crane',
              'chef',
              'taoist',
              'metro',
              'heron',
              'candy',
              'bell',
              'salt',
            ),
          },
        ],
      }),
    ),
    place(
      module('latest', 'shelf', t.latest, { more: siteHref('en', 'fiction', ['browse']) }),
      ready<'shelf'>({
        tabs: [
          { id: 'chapters', label: t.newChapters, items: withChapters },
          {
            id: 'adopted',
            label: t.newlyAdded,
            items: pick('cloud', 'bone', 'ferry', 'bell', 'crane', 'cat', 'metro'),
          },
          { id: 'completed', label: t.completed, items: pick('tea', 'light', 'heron', 'salt') },
        ],
      }),
    ),
    place(
      module('quotes', 'quote-stream', t.quotes),
      ready<'quote-stream'>({
        quotes: [
          {
            id: 'q1',
            body: text(
              '打烊那一章我反复看了三遍，信封里的车票写得太好了，好想知道二十年前发生了什么。',
            ),
            reader: '角角者 178013',
            work: byKey('rain'),
            href: byKey('rain').href,
          },
          {
            id: 'q2',
            body: text('本来不喜欢仙侠，但小道士查案的节奏太爽了，一口气追到最新。'),
            reader: '梦野千里',
            work: byKey('taoist'),
            href: byKey('taoist').href,
          },
          {
            id: 'q3',
            body: text(
              'The delta chapters read like a map you can hear. Slow, strange and worth it.',
              'en',
            ),
            reader: 'marginalia',
            work: byKey('tides'),
            href: byKey('tides').href,
          },
        ],
      }),
    ),
    place(
      module('charts', 'ranking', t.rankings, { more: siteHref('en', 'fiction', ['browse']) }),
      ready<'ranking'>({
        metric: 'reads',
        tabs: (['day', 'week', 'month'] as const).map((interval) => ({
          interval,
          items: rotations[interval].map((key, index) => ({ rank: index + 1, work: byKey(key) })),
        })),
      }),
    ),
    place(
      module('lists', 'editorial-list', t.lists, { more: siteHref('en', 'fiction', ['browse']) }),
      ready<'editorial-list'>({
        lists: [
          {
            id: 'rainy',
            title: text(
              locale === 'zh-Hans'
                ? '【雨天限定】适合下雨天读的故事'
                : 'For rainy days: stories to read while it pours',
              locale === 'zh-Hans' ? 'zh-Hans' : 'en',
            ),
            blurb: text(
              locale === 'zh-Hans'
                ? '雨声、旧书和一点点悬念。编辑部的雨天书单。'
                : 'Rain, old books and a little suspense: the editors’ rainy-day shelf.',
              locale === 'zh-Hans' ? 'zh-Hans' : 'en',
            ),
            href: siteHref('en', 'fiction', ['browse']),
            items: pick('rain', 'metro', 'light', 'crane', 'cloud', 'ferry'),
          },
        ],
      }),
    ),
    place(
      module('rising', 'rising', t.rising, {
        rail: true,
        more: siteHref('en', 'fiction', ['browse']),
      }),
      ready<'rising'>({
        items: pick('cloud', 'bone', 'bell', 'cat', 'ferry', 'crane'),
      }),
    ),
    place(
      module('decisions', 'decision-log', t.decisions, {
        rail: true,
        more: realmHref('en', 'fiction', 'decisions'),
      }),
      ready<'decision-log'>({ items: decisions }),
    ),
  ];
}

export function fictionZone(
  locale: UiLocale,
  tokens: ZoneTokens = presetTokens.serial,
): ZoneContext {
  return {
    slug: 'fiction',
    realm: `https://rezics.com/id/${realmId}`,
    name: text(
      locale === 'zh-Hans' ? '小说 Fiction' : 'Fiction 小说',
      locale === 'zh-Hans' ? 'zh-Hans' : 'en',
    ),
    description: text(
      locale === 'zh-Hans'
        ? '网络连载、轻小说与原创作品，由小说编辑部公开甄选。'
        : 'Web serials, light novels and originals, picked in public by the Fiction editors.',
      locale === 'zh-Hans' ? 'zh-Hans' : 'en',
    ),
    icon: null,
    hero: null,
    tokens,
    locale,
    links: {
      home: siteHref('en', 'fiction', []),
      browse: siteHref('en', 'fiction', ['browse']),
      works: siteHref('en', 'fiction', ['browse']),
      discussions: realmHref('en', 'fiction', 'discussions'),
      decisions: realmHref('en', 'fiction', 'decisions'),
      about: realmHref('en', 'fiction', 'about'),
    },
  };
}

/** A community Realm with only the modules Main serves today: picks, the latest shelf and decisions. */
export function communityModules(locale: UiLocale): PlacedModule[] {
  const t = titlesFor(locale);
  const classics = pick('tides', 'salt', 'ferry', 'heron', 'light', 'tea');
  return [
    place(
      module('picks', 'hero-carousel', t.picks),
      ready<'hero-carousel'>({
        banners: classics.slice(0, 3).map((work) => ({
          id: work.id,
          title: work.title!,
          href: work.href,
          image: null,
          work,
        })),
      }),
    ),
    place(
      module('latest', 'shelf', t.latest, { more: siteHref('en', 'classics', ['browse']) }),
      ready<'shelf'>({
        tabs: [
          { id: 'adopted', label: t.newlyAdded, items: classics },
          { id: 'completed', label: t.completed, items: pick('salt', 'heron', 'light') },
        ],
      }),
    ),
    place(module('rankings', 'ranking', t.rankings), { state: 'unsupported' }),
    place(
      module('decisions', 'decision-log', t.decisions, {
        rail: true,
        more: realmHref('en', 'classics', 'decisions'),
      }),
      ready<'decision-log'>({ items: decisions.slice(0, 4) }),
    ),
  ];
}

export function communityZone(
  locale: UiLocale,
  tokens: ZoneTokens = presetTokens.clean,
): ZoneContext {
  const zh = locale === 'zh-Hans';
  return {
    slug: null,
    realm: 'https://rezics.com/id/7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a',
    name: text(
      zh ? '经典文学 · Classic Literature' : 'Classic Literature · 经典文学',
      zh ? 'zh-Hans' : 'en',
    ),
    description: text(
      zh
        ? '读经典、聊经典：这里收录公版名著与它们的好译本。'
        : 'Reading the classics together: public-domain novels and their best translations.',
      zh ? 'zh-Hans' : 'en',
    ),
    icon: null,
    hero: null,
    tokens,
    locale,
    links: {
      home: siteHref('en', 'classics', []),
      browse: siteHref('en', 'classics', ['browse']),
      works: siteHref('en', 'classics', ['browse']),
      discussions: realmHref('en', 'classics', 'discussions'),
      decisions: realmHref('en', 'classics', 'decisions'),
      about: realmHref('en', 'classics', 'about'),
    },
  };
}

/** A module whose read failed, for the failure story. */
export const failedRanking = place(module('charts', 'ranking', 'Charts'), { state: 'failed' });
