import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const serialFiction = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Serial fiction on REZICS: write chapter by chapter, read without losing your place',
    description:
      'Drafts that cannot vanish, chapters scheduled in your time zone, readers who return to the exact paragraph and discussion that never spoils what comes next.',
  },
  hero: {
    title: 'Write it chapter by chapter. Read it without losing your place.',
    lede: 'A home for stories that keep growing. Authors get a manuscript that cannot vanish and a schedule they control; readers return to the exact paragraph they left and talk about the chapter they just finished, without spoilers from the ones ahead.',
  },
  story: {
    title: 'From draft to Friday night.',
    lede: 'One chapter, from the author’s desk to a reader’s phone.',
    steps: {
      draft: {
        title: 'Write without fear.',
        body: 'Every save is a revision you can restore. Write on the train with no signal, and the chapter waits safely on your device until you reconnect.',
      },
      schedule: {
        title: 'Schedule it in your time zone.',
        body: 'Pick Friday at 20:00 where you live. You see the exact revision that will go out and when each reader will get it.',
      },
      resume: {
        title: 'Readers pick up mid-paragraph.',
        body: 'A reader who stopped halfway on their laptop opens their phone at the same paragraph, with the next chapter one tap away.',
      },
      discuss: {
        title: 'Talk about this chapter, not the next.',
        body: 'Comments anchor to paragraphs, and nobody sees a remark about a chapter they have not reached.',
      },
    },
  },
  showcase: {
    title: 'Everything a serial needs, nothing it does not.',
    lede: 'Tools for the long haul of a story told in parts.',
    tiles: {
      collaborators: {
        title: 'Bring in your editor',
        body: 'Beta readers read, editors suggest, co-authors edit; you publish.',
      },
      backup: {
        title: 'A backup that is complete',
        body: 'Revisions, notes and world, in open formats you can import again.',
      },
      ai: {
        title: 'AI use, declared honestly',
        body: 'Say whether AI helped and how, with enough levels to be true.',
      },
      world: {
        title: 'Your world beside the draft',
        body: 'Characters and places a click from the chapter that needs them.',
      },
      languages: {
        title: 'Every language, including yours',
        body: 'Write in any language; translations stay linked to the original.',
      },
    },
  },
  compare: {
    title: 'A calmer place to write and read serials.',
    lede: 'Serials are a long relationship between an author and readers. Neither should have to fight the tools.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      lost: {
        today: 'A lost connection, a lost chapter',
        rezics: 'Every save a revision you can restore',
      },
      schedule: {
        today: 'Publishing at midnight in someone else’s time zone',
        rezics: 'Your schedule, in your time zone',
      },
      place: {
        today: 'Scrolling to find where you stopped',
        rezics: 'Back to the exact paragraph',
      },
      spoilers: {
        today: 'Comments that spoil the next arc',
        rezics: 'Discussion that stops where you are',
      },
    },
  },
  statement: {
    text: 'Your manuscript is safe here. Your readers always know where they are.',
    body: 'Serial fiction is one of the four first scenarios: dependable drafting and scheduling for authors, calm reading and discussion for readers.',
  },
  ledger: {
    title: 'Serial fiction on REZICS',
    lede: 'Each capability shows where it stands today.',
  },
  cta: {
    title: 'Publish your first chapter on day one.',
    body: 'Leave your email and we will write once, when registration opens.',
  },
});
