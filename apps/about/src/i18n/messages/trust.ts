import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const trust = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Trust on REZICS: suitability, AI disclosure, safety and your data',
    description:
      'Separate choices for teen, sexual and grotesque material, declared AI use, reporting and appeals for everyone, fast action on the worst harms, no trackers and data you can take with you.',
  },
  hero: {
    title: 'You decide what you see. You keep what you make.',
    lede: 'Suitability is a set of separate choices, never a guess. AI use is declared, not hidden. Anyone can report a problem, every decision can be appealed, and your drafts, reading and library stay yours.',
  },
  story: {
    title: 'What happens when something goes wrong.',
    lede: 'A report, from the moment it is filed to its decision.',
    steps: {
      report: {
        title: 'Anyone can report.',
        body: 'Signed in or not, from any page. You get a private link to follow the case.',
      },
      review: {
        title: 'A person reviews the evidence.',
        body: 'Automated checks can flag, but a person decides, with the reported passage in front of them.',
      },
      decide: {
        title: 'The decision comes with its reason.',
        body: 'Which rule applied and what changed, stated plainly to the people involved.',
      },
      appeal: {
        title: 'Every decision can be appealed.',
        body: 'An appeal is reviewed again, and the outcome is recorded with the case.',
      },
    },
  },
  showcase: {
    title: 'The commitments behind it.',
    lede: 'The rules REZICS holds itself to.',
    tiles: {
      suitability: {
        title: 'Suitability you control',
        body: 'Teen, sexual and grotesque material are separate choices; unrated is never shown as general.',
      },
      ai: {
        title: 'AI use, declared',
        body: 'Prose, art and translations say whether AI helped and whether a person reviewed it.',
      },
      training: {
        title: 'Not training data',
        body: 'Private drafts and reading records stay out of training unless you opt in.',
      },
      trackers: {
        title: 'No trackers',
        body: 'No advertising trackers and no third-party analytics.',
      },
      export: {
        title: 'Your data leaves with you',
        body: 'Library, notes and drafts export whole.',
      },
      safety: {
        title: 'The worst harms first',
        body: 'Known abuse imagery blocked at upload; intimate images shared without consent removed within 48 hours.',
      },
    },
  },
  compare: {
    title: 'Trust you can check.',
    lede: 'Safety and honesty are rules you can read, not moods.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      ratings: {
        today: 'Unrated content shown as suitable for everyone',
        rezics: 'Unrated stays unrated until assessed',
      },
      ai: {
        today: 'AI-written text passed off as human',
        rezics: 'AI use declared and filterable',
      },
      detectors: {
        today: 'An AI detector treated as proof',
        rezics: 'People decide, detectors never do',
      },
      appeals: {
        today: 'Bans without a reason or an appeal',
        rezics: 'A reason for every decision, an appeal for every case',
      },
    },
  },
  statement: {
    text: 'Safety is not a setting. It is how every page is served.',
    body: 'Suitability, spoilers, privacy and blocks are checked by the server for every page, search result, notification and export, not hidden in the browser.',
  },
  ledger: {
    title: 'Trust on REZICS',
    lede: 'Each commitment shows where it stands today.',
  },
  cta: {
    title: 'Hear when registration opens.',
    body: 'Leave your email and we will write once. We keep your address and language for that alone.',
  },
});
