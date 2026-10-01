import { materializeData } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// The position control in a Zone's frame. What a position is called comes from the Work's own chapters, and
// nothing here names a kind of thing.
const en = {
  region: 'Reading position',
  upTo: 'Up to:',
  upToEverything: 'Showing everything',
  yourProgress: 'your progress',
  startOfStory: 'start of the story',
  chosen: 'your choice',
  showEverything: 'Show everything',
  sheetTitle: 'Read up to',
  sheetBody: 'Pages show only what the story has revealed up to the position you choose.',
  progressOption: 'Your own progress',
  progressNote: 'Currently',
  progressNoneNote: 'You have not finished a chapter yet, so you start at the first one.',
  everythingOption: 'Show everything',
  everythingNote: 'Includes records revealed in chapters you have not read.',
  moreChapters: 'The story has more chapters than this list shows. Use Show everything to see the rest.',
  unavailable: 'The reading position cannot be chosen right now.',
  close: 'Close',
};

export const englishMessages = en;
export type WikiMessages = typeof en;

export const messages = defineMessages({
  en,
  'zh-Hant': withEnglish(en, zhHant),
  'zh-Hans': withEnglish(en, zhHans),
  ja: withEnglish(en, ja),
  ko: withEnglish(en, ko),
  de: withEnglish(en, de),
  fr: withEnglish(en, fr),
  es: withEnglish(en, es),
});

export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type Copy = ReturnType<typeof copyOf>;
