import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const acgn = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Visual novels, anime and manga on REZICS: the release you can use',
    description:
      'Choose visual novels by language, platform and translation, track anime by the episode and manga by the chapter, and talk about them without spoilers past where you are.',
  },
  hero: {
    title: 'The release you can play. The episode you are on.',
    lede: 'Find a visual novel by the language, platform and translation you need, and see who translated it before you start. Track anime by the episode and manga by the chapter on one list, and never meet a spoiler from past where you are.',
  },
  story: {
    title: 'Choosing a visual novel, honestly.',
    lede: 'The same title can be three different experiences. REZICS shows which one you are getting.',
    steps: {
      releases: {
        title: 'Every release, side by side.',
        body: 'The original, the official translation and the fan patch each have their own row: language, platform, edition and date.',
      },
      provenance: {
        title: 'Who translated it, and from what.',
        body: 'A fan translation credits its group, says which version it was made from and how much of the game it covers.',
      },
      track: {
        title: 'Track it your way.',
        body: 'Routes for visual novels, episodes for anime, chapters for manga and volumes for novels, all on one list.',
      },
      discuss: {
        title: 'Talk without spoiling.',
        body: 'Discussion, tags and wiki pages hold back anything past the route, episode or chapter you have reached.',
      },
    },
  },
  showcase: {
    title: 'For people who watch, read and play.',
    lede: 'Anime, comics, games and novels share one catalogue, so an adaptation is always a link away from its source.',
    tiles: {
      season: {
        title: 'This season',
        body: 'Next unwatched episodes and new releases across everything you follow.',
      },
      adaptations: {
        title: 'Adaptations, connected',
        body: 'The novel, the manga and the anime of one story, linked, without the anime spoiling the books.',
      },
      credits: {
        title: 'Credits that mean something',
        body: 'Every credit names the person, the role, the release and, for voice work, the character.',
      },
      zone: {
        title: 'The ACGN Zone',
        body: 'Seasons, releases and discussion over the same catalogue as every other Zone.',
      },
    },
  },
  compare: {
    title: 'Less detective work, more playing.',
    lede: 'Finding a usable release should not mean reading four forum threads.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      threads: {
        today: 'Forum threads to learn whether a patch is complete',
        rezics: 'Coverage and translator on the release itself',
      },
      lists: {
        today: 'One site for anime, another for novels',
        rezics: 'One list, each medium in its own units',
      },
      spoilers: {
        today: 'Tags that spoil the last route',
        rezics: 'Tags and pages that stop where you are',
      },
      titles: {
        today: 'Titles forced into one language',
        rezics: 'Every title in its own language, with aliases',
      },
    },
  },
  statement: {
    text: 'Choose by language, platform and translation, not by title alone.',
    body: 'Visual-novel discovery by usable release is one of the four first scenarios, and anime and manga tracking share its foundations.',
  },
  ledger: {
    title: 'Visual novels, anime and manga on REZICS',
    lede: 'Each capability shows where it stands today.',
  },
  cta: {
    title: 'Start your list on day one.',
    body: 'Leave your email and we will write once, when registration opens.',
  },
});
