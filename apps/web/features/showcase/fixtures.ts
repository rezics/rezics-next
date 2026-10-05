import type {
  ZoneShowcaseArt,
  ZoneShowcaseSlide,
  ZoneShowcaseImage,
  ZoneText,
  ZoneWork,
} from '@rezics/zone-sdk';
import { direction } from '@rezics/main/language';
import { resourceHref, spaceHref } from '../address/path.ts';
import landscapeUrl from './art/landscape.svg?url&no-inline';
import portraitUrl from './art/portrait.svg?url&no-inline';
import englishLight from './art/logo-en-light.svg?url&no-inline';
import englishDark from './art/logo-en-dark.svg?url&no-inline';
import japaneseLight from './art/logo-ja-light.svg?url&no-inline';
import japaneseDark from './art/logo-ja-dark.svg?url&no-inline';
import cutoutUrl from './art/cutout.svg?url&no-inline';
import type { UiLocale } from '../../i18n/define.ts';
import { messages, type ZoneMessages } from '../zones/messages.ts';
import traditional from '../zones/messages/zh-Hant.ts';
import japanese from '../zones/messages/ja.ts';

export type ShowcaseLanguage = 'en' | 'zh-Hant' | 'ja' | 'ar';
const texts = {
  en: [
    'Astral Tide',
    'A lighthouse between worlds. A letter that never reached home.',
    'New worlds',
    'The Cartographer’s Library',
    'Follow a map into a city that remembers every reader.',
  ],
  'zh-Hant': [
    '星潮',
    '世界交界的燈塔，與一封從未抵達故鄉的信。',
    '新的世界',
    '製圖師的圖書館',
    '沿著地圖，走進一座記得每位讀者的城市。',
  ],
  ja: [
    '星の潮',
    '世界の境に立つ灯台。故郷に届かなかった一通の手紙。',
    '新しい世界',
    '地図職人の図書館',
    'すべての読者を覚えている街へ、地図をたどろう。',
  ],
  ar: [
    'مدّ النجوم',
    'منارة بين عالمين، ورسالة لم تصل إلى الوطن.',
    'عوالم جديدة',
    'مكتبة رسّام الخرائط',
    'اتبع الخريطة إلى مدينة تتذكّر كل قارئ.',
  ],
} as const;
const text = (value: string, lang: ShowcaseLanguage): ZoneText => ({
  value,
  lang,
  dir: direction(lang, value),
});
const image = (url: string, width: number, height: number): ZoneShowcaseImage => ({
  url,
  width,
  height,
  candidates: [{ url, width }],
  framed: true,
});
export const fixtureArt: ZoneShowcaseArt = {
  landscape: {
    ...image(landscapeUrl, 1600, 900),
    focal: { x: 0.63, y: 0.25, width: 0.18, height: 0.45 },
  },
  portrait: {
    ...image(portraitUrl, 750, 1000),
    focal: { x: 0.56, y: 0.25, width: 0.23, height: 0.4 },
  },
  cutout: image(cutoutUrl, 420, 700),
  logos: [
    { ...image(englishLight, 600, 200), language: 'en', tone: 'light', anchor: 'start-bottom' },
    { ...image(englishDark, 600, 200), language: 'en', tone: 'dark', anchor: 'start-bottom' },
    { ...image(japaneseLight, 600, 200), language: 'ja', tone: 'light', anchor: 'start-bottom' },
    { ...image(japaneseDark, 600, 200), language: 'ja', tone: 'dark', anchor: 'start-bottom' },
  ],
};
export function showcaseFixtures(language: ShowcaseLanguage): ZoneShowcaseSlide[] {
  const [title, tagline, kicker, second, hook] = texts[language];
  const firstHref = resourceHref('/w/', '01a0e3d1-0000-7000-8000-000000000001');
  const secondHref = resourceHref('/w/', '01a0e3d1-0000-7000-8000-000000000002');
  const work: ZoneWork = {
    id: 'https://rezics.com/id/01a0e3d1-0000-7000-8000-000000000001',
    href: firstHref,
    title: text(title, language),
    tagline: text(tagline, language),
    cover: null,
    kind: 'book',
    author: null,
    status: null,
    chapters: null,
    words: null,
    updatedAt: null,
    decision: `${spaceHref('fiction', 'community', ['decisions'])}#astral-tide`,
  };
  return [
    {
      id: 'astral-tide',
      href: work.href,
      title: work.title!,
      kicker: text(kicker, language),
      tagline: work.tagline,
      work,
      art: fixtureArt,
    },
    {
      id: 'cartographer',
      href: secondHref,
      title: text(second, language),
      tagline: text(hook, language),
      work: {
        ...work,
        id: 'https://rezics.com/id/01a0e3d1-0000-7000-8000-000000000002',
        href: secondHref,
        title: text(second, language),
        tagline: text(hook, language),
      },
    },
    {
      id: 'horizon',
      href: firstHref,
      title: text(title, language),
      tagline: text(tagline, language),
      art: { landscape: fixtureArt.landscape },
    },
  ];
}
export const showcaseCopy = (language: ShowcaseLanguage): ZoneMessages =>
  language === 'zh-Hant'
    ? { ...messages, ...traditional }
    : language === 'ja'
      ? { ...messages, ...japanese }
      : messages;
export const showcaseLocale = (language: ShowcaseLanguage): UiLocale =>
  language === 'ar' ? 'en' : language;
export const showcaseViewports = {
  phone: [390, 844],
  foldCover: [412, 960],
  tabletPortrait: [820, 1180],
  tabletLandscape: [1180, 820],
  foldInner: [984, 1092],
  phoneLandscape: [844, 390],
  desktop: [1280, 860],
  desktopWide: [1920, 1080],
} as const;
