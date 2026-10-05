import type { ZonePresentation } from '../../../services/main/src/modules/zone/presentation-format.ts';

/**
 * Showcase art for a few Works of different kinds, drawn from the fixture art
 * under `apps/web/features/showcase/art`. Each Work gets its own hue, and its
 * logos carry its own name, so the stores' hero reads as three different titles.
 * `celeste` is left without art on purpose: its slides fall back to its cover.
 */
export type ShowcaseRoleKey =
  | { role: 'background-landscape' | 'background-portrait' | 'cutout' }
  | { role: 'logo'; language: 'en' | 'ja'; tone: 'light' | 'dark' };

export interface ShowcaseWork {
  /** The plan id of a Work the base seed created (`works`) or a Zone published (`gamesCatalogue`, `softwareCatalogue`). */
  id: string;
  kind: 'book' | 'game' | 'software';
  hue: number;
  names: { en: string; ja: string };
  slots: readonly ShowcaseRoleKey[];
  trailer?: string;
}

const logos = (...keys: ['en' | 'ja', 'light' | 'dark'][]) =>
  keys.map(([language, tone]) => ({ role: 'logo' as const, language, tone }));

export const showcaseWorks: readonly ShowcaseWork[] = [
  { id: 'pride', kind: 'book', hue: 0, names: { en: 'Pride and Prejudice', ja: '高慢と偏見' },
    // Landscape and portrait backgrounds with logos in two languages and both tones.
    slots: [{ role: 'background-landscape' }, { role: 'background-portrait' },
      ...logos(['en', 'light'], ['en', 'dark'], ['ja', 'light'], ['ja', 'dark'])] },
  { id: 'game-hades', kind: 'game', hue: 150, names: { en: 'Hades', ja: 'ハデス' },
    // The one cutout and the one trailer.
    slots: [{ role: 'background-landscape' }, { role: 'background-portrait' }, { role: 'cutout' },
      ...logos(['en', 'light'])],
    trailer: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
  { id: 'app-krita', kind: 'software', hue: 280, names: { en: 'Krita', ja: 'クリタ' },
    // No portrait: a phone falls back to the landscape art around its focal area.
    slots: [{ role: 'background-landscape' }, ...logos(['en', 'dark'])] },
];

/** Works with slides in the Zone but no art: their slides compose from the cover. */
export const showcaseUnarted = ['game-celeste'] as const;

/** The Zone whose home leads with the showcase. */
export const showcaseZone = 'games' as const;

type Slides = ZonePresentation['slides'];

/**
 * v2 slides mixing the Works above: a game with a trailer, a book, a piece of
 * software, a link slide for a campaign, and a scheduled slide for a Work
 * with no art. The fixed window keeps the plan the same on every run.
 */
export function showcaseSlides(workOf: (id: string) => string | undefined): Slides {
  const work = (id: string) => workOf(id);
  const hades = work('game-hades'), pride = work('pride'), krita = work('app-krita'), celeste = work('game-celeste');
  return [
    ...hades ? [{ id: 'underworld', work: hades, kicker: 'Game of the week',
      kickers: { 'zh-Hans': '本周游戏', 'zh-Hant': '本週遊戲', ja: '今週のゲーム' } }] : [],
    ...pride ? [{ id: 'book-club', work: pride, kicker: 'Book club pick',
      kickers: { 'zh-Hans': '读书会选书', 'zh-Hant': '讀書會選書', ja: '読書会の一冊' } }] : [],
    ...krita ? [{ id: 'make-something', work: krita, kicker: 'Make something',
      kickers: { 'zh-Hans': '动手创作', 'zh-Hant': '動手創作', ja: '作ってみよう' } }] : [],
    // A campaign has no Work: it links into a Realm. Its art waits for an API that lets a Zone's editors upload it.
    { id: 'autumn-contest', href: '/r/fiction', title: 'Autumn serial contest',
      titles: { 'zh-Hans': '秋季连载征文', 'zh-Hant': '秋季連載徵文', ja: '秋の連載コンテスト' },
      kicker: 'Open until October 31',
      kickers: { 'zh-Hans': '十月三十一日截止', 'zh-Hant': '十月三十一日截止', ja: '10月31日まで' } },
    ...celeste ? [{ id: 'climb-week', work: celeste, kicker: 'This season',
      kickers: { 'zh-Hans': '本季', 'zh-Hant': '本季', ja: '今シーズン' },
      startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2030-01-01T00:00:00.000Z' }] : [],
  ];
}

/** The slides a Zone's configuration already holds, so replaying its layout does not clear them. */
export function retainedSlides(presentation: unknown): Slides {
  const slides = presentation && typeof presentation === 'object' && 'slides' in presentation
    ? presentation.slides : [];
  return Array.isArray(slides) ? slides as Slides : [];
}
