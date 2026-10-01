import { asValue, insert, materializeData, number, plural } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface copy for the add-to-the-catalogue wizard and the unverified notice on a Work. Main's own
// words (a refusal's reason, a Work's title) are never here; this catalog frames them.
const en = {
  heading: 'Add to the catalogue',
  intro: 'Search first: most books, translations and editions are already here. Only if nothing fits do you add something new.',

  searchLegend: 'Search the catalogue',
  searchLabel: 'Title, alias, creator or ISBN',
  searchHelp: 'Type any name the work goes by, in any language: Japanese, romaji or English.',
  languageLabel: 'Language of what you typed',
  languageUndetermined: 'Not sure',
  creatorLabel: 'Creator (optional)',
  creatorHelp: 'An author or illustrator narrows the matches.',
  searching: 'Searching…',
  searchFailed: 'The search could not be completed',
  searchUnavailable: 'The catalogue could not be reached. Nothing was added.',
  searchSignedOut: 'Sign in again to search the catalogue.',
  searchInvalid: 'That could not be searched. Check the title, language and ISBN.',
  searchRetry: 'Search again',

  resultsHeading: 'Existing records',
  found: plural({ one: insert('{{count}} existing record found'), other: insert('{{count}} existing records found') },
    { count: asValue(number()) }),
  none: 'Nothing matches yet.',
  sampled: 'The search is a sample. A list here shows you looked, not that no record exists; if something looks right, use it.',
  matchedAs: 'Also known as',
  by: insert('by {{creators}}', { creators: String }),
  unverified: 'Unverified',
  verified: 'Verified',
  unverifiedHelp: 'Added by a contributor and not yet checked by a reviewer.',

  useExisting: 'Use this record',
  addAlias: 'Add an alias',
  addTranslation: 'Add a translation or edition',
  addPart: 'Add a part to this series',
  candidateActions: insert('What to do with {{title}}', { title: String }),

  aliasHeading: insert('Add an alias to {{title}}', { title: String }),
  aliasLabel: 'Alias',
  aliasLanguage: 'Language of the alias',
  aliasSave: 'Save alias',
  aliasSaving: 'Saving…',
  aliasSaved: 'Saved. The alias now finds this record.',
  aliasDenied: 'You can’t change this record’s names. Ask its maintainers, or propose a correction on its page.',
  aliasTaken: 'This record already has a title in that language. Use its page to change it.',
  aliasInvalid: 'Give an alias and its language.',
  aliasFailed: 'The alias could not be saved. Nothing was changed.',
  cancel: 'Cancel',

  createPrompt: 'None of these is it?',
  createButton: 'Add something new',

  stepTwoHeading: 'What are you adding?',
  stepTwoIntro: insert('You searched for “{{title}}”. Say what it is, so it is recorded at the right level.', { title: String }),
  kindLegend: 'What the record is',
  kindStory: 'A new story or series',
  kindStoryHelp: 'A creative work that is not among the results.',
  kindTranslation: 'A translation or version',
  kindTranslationHelp: 'A text of a record that already exists, in another language or form. It is added to that record, not as a new work.',
  kindPublication: 'A publication',
  kindPublicationHelp: 'A published edition of a record that already exists, such as a paperback, an ebook or an omnibus.',
  kindPart: 'A part of a series',
  kindPartHelp: 'A volume or episode that belongs to a series in the results. It is created, then listed in the series.',
  kindCollection: 'A collection',
  kindCollectionHelp: 'A set of records gathered together.',
  parentLegend: 'Which existing record?',
  parentLegendPart: 'Which series does it belong to?',
  parentNone: 'No result fits. Go back and search for the record first.',
  typeLabel: 'Kind of work',
  typeNone: 'Not specified',
  back: 'Back to the results',
  continue: 'Continue',
  createRecord: 'Create record',
  creating: 'Creating…',
  routing: 'Opening the page where this is added…',
  routedTo: insert('Main directs this to {{api}}.', { api: String }),
  routeMissing: 'The web app has no page for this yet. Main’s answer is shown so the change can be made another way.',
  routeDenied: 'You can’t add this. Sign in with an identity that may add to the catalogue.',
  routeUnavailable: 'Main could not say where this goes. Nothing was added.',

  createdHeading: 'Record created',
  createdBody: 'It is visible now and is marked unverified until a reviewer checks it.',
  openRecord: 'Open the record',
  addToSeries: insert('Add it to {{series}}', { series: String }),
  addAnother: 'Add another',
  createPending: 'Main is still creating the record. Press the button again in a moment; it will not be created twice.',
  createDenied: 'You can’t add records to the catalogue with this identity.',
  createUnavailable: 'The record could not be created. Nothing was added; try again in a moment.',
  searchAgain: 'The search this creation follows has expired or no longer matches. Search again, then continue.',
  limitTitle: 'Three records are waiting for review',
  limitBody: 'A new contributor can have three records waiting for a reviewer at once. You can add more as soon as one is verified.',
  limitRetry: insert('Main says to try again in {{wait}}.', { wait: String }),
  limitRetryUnknown: 'Main did not say when to try again.',

  signInTitle: 'Sign in to add to the catalogue',
  signInBody: 'Searching and adding use your identity, so each record names who added it.',
  signInButton: 'Sign in',
  noIdentityTitle: 'Choose an identity first',
  noIdentityBody: 'Pick the identity you add records as from your account, then come back.',

  noticeBadge: 'Unverified',
  noticeBody: 'A contributor added this record and a reviewer has not checked it yet. It is left out of recommendations and trusted exports until then.',
  provenanceHeading: 'Where these fields came from',
  provenanceBody: insert('Entered by a contributor when the record was created, following the search recorded as {{receipt}}.', { receipt: String }),
  fieldTitle: 'Title', fieldLanguage: 'Language', fieldGrain: 'Kind of record', fieldParentComposition: 'Parent',
  fieldLocalizedTitle: 'Localized title', fieldDescription: 'Description', fieldSemanticTypes: 'Type',
  fieldAliases: 'Aliases', fieldRomanizations: 'Romanizations',
};

export const englishMessages = en;
export type CatalogueIntakeMessages = typeof en;

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

/** The interface strings of one locale, ready to call (`t.found(3)`). */
export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type Copy = ReturnType<typeof copyOf>;
