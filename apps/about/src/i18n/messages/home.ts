import { defineEnglishCopy } from '../define.ts';

/** A home section's heading and lede. */
interface Section {
  title: string;
  lede: string;
}

export interface HomeCopy {
  meta: { title: string; description: string };
  hero: { title: string; lede: string; primary: string; secondary: string };
  /** What the hero's deck shows, for people who cannot see it. */
  heroPicture: string;
  /** Message one: a work's details in the language you read. */
  language: Section;
  /** Message two: the whole community around a story. */
  community: Section;
  /** Message three: fans of one story from every platform, together. */
  together: Section;
  /** Every kind of story, from the same parts. */
  kinds: Section;
  lines: Section;
  why: Section;
  glance: Section & { link: string };
  cta: { title: string; body: string };
}

export const home = defineEnglishCopy<HomeCopy>({
  meta: {
    title: 'REZICS: every story, every language, one home',
    description:
      'Web novels, light novels, books, visual novels, anime, manga, games and more, each with a complete page in the language you read, a whole community around it, and fans from every platform in one place.',
  },
  hero: {
    title: 'Every story. Every language. One home.',
    lede: 'Web novels and light novels, books and visual novels, anime, manga and games, even AI prompts and recipes. REZICS gives each one a complete home, shows it in the language you read, and brings together everyone who loves it, wherever they found it.',
    primary: 'Get notified',
    secondary: 'See the roadmap',
  },
  heroPicture:
    'A deck of stories of every kind: a light novel, a visual novel, a web serial, an anime, a manga, a game, an AI prompt and a recipe, each named in the several languages it is read in.',
  language: {
    title: 'Don’t read Japanese? It doesn’t matter.',
    lede: 'REZICS keeps a work’s details in the language they were written in, from titles and synopsis to credits, tags, editions and releases, and presents them in English or in any language you read. Choose a language and watch the record change in place.',
  },
  community: {
    title: 'Want more from a story’s community? It’s all here.',
    lede: 'Discussion that knows where you are in the story, reviews, lists, wikis, moderation that explains itself, and one identity that goes with you everywhere. Move your place in the story and see what waits for you.',
  },
  together: {
    title: 'Bring fans together, beyond any one platform.',
    lede: 'One story is read as a web serial, bought as a light novel, watched as an anime and played as a game, in a dozen languages. On REZICS every version meets on one page, and everyone who loves it meets in one Realm.',
  },
  kinds: {
    title: 'One home for every kind of story.',
    lede: 'Every kind gets a complete page from the same parts, so a recipe is as well kept as a light novel, and each shows the facts that matter for it.',
  },
  lines: {
    title: 'Reading is one room. Here is the whole house.',
    lede: 'A library for readers, a studio for writers, wikis, Realms, agents and publishing share the same records, so a story, its translations, its wiki and its people are never more than a link apart.',
  },
  why: {
    title: 'Why REZICS',
    lede: 'Five commitments hold every part of it together.',
  },
  glance: {
    title: 'Where it is going',
    lede: 'Registration opens once the first scenarios work end to end: following a series across languages, a library you can take with you, serial fiction, and finding the visual-novel release you can play. This is the order the work happens in.',
    link: 'Read the roadmap',
  },
  cta: {
    title: 'Be there when the doors open.',
    body: 'Leave your email and we will write once, when registration opens. Nothing else.',
  },
});
