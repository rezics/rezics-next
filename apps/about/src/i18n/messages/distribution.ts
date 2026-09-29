import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const distribution = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Publishing on REZICS: books and games sold as files people keep',
    description:
      'REZICS sells rights-cleared books, small games and visual novels from contracted creators as DRM-free files, next to the Work’s community and wiki, with every deduction on the statement.',
  },
  hero: {
    title: 'Sell books and games as files people keep.',
    lede: 'REZICS distributes rights-cleared books, small games and visual novels from the creators it works with: DRM-free files, the exact language edition a reader wants, and a store page that sits beside the Work’s community and wiki. Every deduction shows on the creator’s statement.',
  },
  story: {
    title: 'One purchase, start to finish.',
    lede: 'From choosing an edition to downloading it again years later.',
    steps: {
      choose: {
        title: 'Choose the exact edition.',
        body: 'The Traditional Chinese edition, translated by the credited translator, with a sample to read first.',
      },
      buy: {
        title: 'Pay once, see the total first.',
        body: 'The price with tax is shown before checkout, and the receipt lands in your library.',
      },
      keep: {
        title: 'Keep the file.',
        body: 'Download a DRM-free EPUB or PDF, or the game build for your platform, and download it again whenever you like.',
      },
      update: {
        title: 'Get the updates.',
        body: 'A corrected edition or a patched build arrives in your library with its changelog, and earlier versions stay available.',
      },
    },
  },
  showcase: {
    title: 'A store that knows the story.',
    lede: 'Selling is one part of a Work’s life on REZICS, not a separate place.',
    tiles: {
      statements: {
        title: 'Every deduction on the statement',
        body: 'Tax, payment fees and refunds, line by line.',
      },
      rights: {
        title: 'Rights, stated plainly',
        body: 'Who made it, who translated it and what readers may do with it.',
      },
      connected: {
        title: 'The Realm and wiki next door',
        body: 'A purchase lives beside the Work’s discussion and wiki.',
      },
      creators: {
        title: 'Creators across media',
        body: 'Follow an author or translator across books and games.',
      },
    },
  },
  compare: {
    title: 'What readers and creators get.',
    lede: 'Straightforward terms for the people who make things and the people who buy them.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      drm: {
        today: 'Books locked to one app',
        rezics: 'DRM-free files you keep',
      },
      editions: {
        today: 'Language editions buried under “English”',
        rezics: 'Each language edition on its own',
      },
      statements: {
        today: 'A payout with the arithmetic hidden',
        rezics: 'Every deduction on the statement',
      },
      silo: {
        today: 'A store page cut off from the community',
        rezics: 'The Work, its Realm and its wiki together',
      },
    },
  },
  statement: {
    text: 'Buy it once. Keep the file. Know where the money went.',
    body: 'Publishing begins with a small group of contracted creators and opens after payments are approved. Sexually explicit works are not sold.',
  },
  ledger: {
    title: 'Publishing on REZICS',
    lede: 'Each capability shows where it stands today.',
  },
  cta: {
    title: 'Hear when publishing opens.',
    body: 'Leave your email and we will write once, when registration opens.',
  },
});
