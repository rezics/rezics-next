import { defineEnglishCopy } from '../define.ts';

export interface HomeCopy {
  meta: { title: string; description: string };
  hero: { title: string; lede: string; primary: string; secondary: string };
  /** What the hero picture shows, for people who cannot see it. */
  heroPicture: string;
  /** The four first scenarios as a pinned scroll story; step keys are the scenario's feature ids. */
  story: {
    title: string;
    lede: string;
    steps: Record<
      'series-tracking' | 'library-import' | 'serial-reading' | 'vn-releases',
      { title: string; body: string }
    >;
  };
  lines: { title: string; lede: string };
  why: { title: string; lede: string };
  glance: { title: string; lede: string; link: string };
  cta: { title: string; body: string };
}

export const home = defineEnglishCopy<HomeCopy>({
  meta: {
    title: 'REZICS: one story, every language and edition, yours to keep',
    description:
      'Follow light novels, books, web serials, visual novels, anime and manga across every language and edition, keep a library you can take anywhere, and read the wiki at your chapter.',
  },
  hero: {
    title: 'One story. Every language and edition. Yours to keep.',
    lede: 'REZICS follows a story from its original through every translation and edition, remembers your place in each, and lets you take the whole library with you. For novels, light novels, web serials, visual novels, anime and manga.',
    primary: 'Get notified',
    secondary: 'See the roadmap',
  },
  heroPicture:
    'One light novel in Japanese, Traditional Chinese and English. The covers change language while your place in the story stays marked.',
  story: {
    title: 'Start with what you do every week.',
    lede: 'Four jobs readers repeat all year come first. Everything else on REZICS grows from them.',
    steps: {
      'series-tracking': {
        title: 'Know which volume comes next.',
        body: 'Your series lined up in Japanese, English and Traditional Chinese, with what you own and what you have read. When volume 7 is dated in the language you read, it is on your page that day.',
      },
      'library-import': {
        title: 'Bring your library. Keep every edition.',
        body: 'Import years of history from another site. Each book is matched to the edition you actually read, you decide when two look alike, and you see what will not carry over before anything changes.',
      },
      'serial-reading': {
        title: 'Pick up exactly where you stopped.',
        body: 'Web serials that remember your paragraph on every device, keep later chapters out of the comments and put the discussion beside the chapter you just finished.',
      },
      'vn-releases': {
        title: 'Find the release you can play.',
        body: 'Choose a visual novel by the language, platform and translation you need, and see who translated it and how complete it is before you start.',
      },
    },
  },
  lines: {
    title: 'Every part of a story’s life, on one catalogue.',
    lede: 'Reading, writing, wikis, communities and publishing share the same records, so a book, its translations, its wiki and its readers are never more than a link apart.',
  },
  why: {
    title: 'Why REZICS',
    lede: 'Five commitments hold every product line together.',
  },
  glance: {
    title: 'Where it is going',
    lede: 'Registration opens when the four first scenarios are complete and the launch checks pass. This is the order the work happens in.',
    link: 'Read the roadmap',
  },
  cta: {
    title: 'Be there when the doors open.',
    body: 'Leave your email and we will write once, when registration opens. Nothing else.',
  },
});
