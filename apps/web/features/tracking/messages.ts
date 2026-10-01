import { asValue, insert, materializeData, number, plural } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface copy for the reader's attempts and series progress. Every state, count and reason shown
// beside this copy is Main's; the catalog only names them.
const en = {
  details: 'Details', sheetTitle: 'Reading details', sheetFor: insert('Attempts at “{{title}}”', { title: String }),
  attempts: 'Attempts', noAttempts: 'No attempts recorded yet.',
  loadFailed: 'Attempts could not be loaded.', retry: 'Try again', showMore: 'Show more',
  saveFailed: 'Couldn’t save. Try again.',

  statePlanned: 'Planned', stateActive: 'Reading', statePaused: 'Paused', stateDnf: 'Did not finish', stateFinished: 'Finished',
  status: 'Status',
  moveActive: 'Resume', movePaused: 'Pause', moveDnf: 'Mark did not finish', moveFinished: 'Mark finished',
  firstRead: 'First read', reread: insert('Reread {{number}}', { number: String }),
  dnfNote: 'Did not finish ends this attempt. To read it again, start a new one.',
  endedNote: 'This attempt has ended. To read it again, start a new one.',
  twoOpen: 'Two attempts are open, perhaps begun on two devices. Close one by finishing it or marking it did not finish.',

  start: 'Start an attempt', startReread: 'Start a reread', plan: 'Plan it', startReading: 'Start reading',
  startedOn: 'Started', finishedOn: 'Finished',
  dateUnknown: 'Unknown',
  today: 'Today', markUnknown: 'Mark unknown', saveDate: 'Save', invalidDate: 'Use a year, a month or a day, such as 2024-05.',

  editions: 'Editions and formats',
  editionsNote: 'An edition or format, once added, stays with the attempt.',
  editionsFailed: 'Editions could not be loaded; you can still record the Work itself.',
  moreEditions: 'The Work has more editions than are listed here.',
  workInGeneral: 'The Work itself', chooseEdition: 'Choose an edition', edition: 'Edition', format: 'Format', noFormat: 'No format',
  formatPrint: 'Print', formatEbook: 'E-book', formatAudiobook: 'Audiobook', formatWeb: 'Web',
  addEdition: 'Add', unnamedEdition: 'Selected edition',
  originalText: insert('{{language}} original', { language: String }),
  translationText: insert('{{language}} translation', { language: String }),
  noEditionsLeft: 'Every edition listed is already part of this attempt.',

  positionUnit: 'Unit', positionValue: 'Value',
  unitPage: 'Page', unitPercentage: 'Percent', unitMediaTime: 'Time',
  positionNow: 'Now', positionFurthest: 'Furthest',
  atPage: insert('page {{value}}', { value: String }), atPercentage: insert('{{value}}%', { value: String }),
  atTime: insert('{{value}}', { value: String }),
  savePosition: 'Save position',
  needsEdition: 'Choose an edition to record a page, percentage or time. The Work on its own has no pages.',
  structureNote: 'This text is read chapter by chapter; each chapter keeps its own position.',
  invalidPosition: 'Enter a whole page, a percentage up to 100, or a time such as 1:02:03.',

  conflictTitle: 'Changed on another device',
  conflictBody: 'This attempt changed after you opened it, so your change was not saved. Choose which to keep.',
  conflictMine: 'Your change', conflictTheirs: 'On the other device', notSet: 'Not set',
  keepMine: 'Keep my change', useTheirs: 'Use the other version',
  conflictFailed: 'Your change no longer applies to the attempt as it is now.',
  conflictStarted: 'Started', conflictFinished: 'Finished on', conflictPosition: 'Position',
  conflictEdition: insert('Add {{edition}}', { edition: String }),

  workProgress: 'Your progress', notStarted: 'Not started',
  seriesProgress: 'Series progress', seriesUnavailable: 'Series progress could not be loaded.',
  stateCaughtUp: 'Caught up with available material', stateFinishedParts: 'Finished the published parts',
  stateConcluded: 'Series concluded', stateCorrespondence: 'Correspondence unresolved',
  yes: 'Yes', no: 'No', unknown: 'Unknown',
  partialNote: 'This series has more parts than one page holds, so whether you are caught up or finished is not known here.',
  countsLine: plural({
    one: insert('{{completedRequired}} of {{count}} required part finished'),
    other: insert('{{completedRequired}} of {{count}} required parts finished'),
  }, { count: asValue(number()), completedRequired: String }),
  partsFinished: plural({ one: insert('{{count}} part finished in all'), other: insert('{{count}} parts finished in all') },
    { count: asValue(number()) }),
  nextPart: 'Next part', noNext: 'Nothing left to read.',
  reasonNextAvailable: 'The next required part you can read in this language.',
  reasonAwaiting: 'The next required part, which has no text in this language yet.',
  reasonOptional: 'An optional part or extra.',
  unnamedPart: 'Unnamed part', optionalPart: 'Optional', extraPart: 'Extra',
  furthestFinished: 'Furthest part finished',
  preference: 'Language and edition', preferenceNote: 'Your private choice for this series. It decides which language counts as available and which edition comes next.',
  language: 'Language', anyEdition: 'Any edition', savePreference: 'Save choice', preferenceSaved: 'Saved.',
  preferenceStale: 'Your choice was changed on another device.', preferenceStaleBody: 'The other device’s choice is the one saved. Keep yours or use it.',
  alsoMark: insert('Also mark “{{title}}” as read', { title: String }),
  alsoMarkNote: insert('You finished this, and “{{title}}” is recorded as corresponding to it. Nothing is marked until you choose.', { title: String }),
  marked: insert('“{{title}}” is marked as read.', { title: String }),
  correspondences: 'Corresponding Works',
};

export const englishMessages = en;
export type TrackingMessages = typeof en;

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

/** The interface strings of one locale, ready to call (`t.reread(2)`). */
export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type Copy = ReturnType<typeof copyOf>;
