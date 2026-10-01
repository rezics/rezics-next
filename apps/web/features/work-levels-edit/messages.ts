import { asValue, insert, materializeData, number, plural } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface copy for the parts, relations and editions edit pages. Relation labels are never here:
// Main renders them in the editor's language (docs/contracts/semantic-model.md#relation-lexicon).
// A refusal's reason is Main's own text, shown under the headline this catalog gives the kind of refusal.
const en = {
  edit: 'Edit', editSections: 'Edit sections', editStructure: 'Edit structure',
  tabParts: 'Parts', tabRelations: 'Relations', tabEditions: 'Editions',
  backToWork: 'Back to the Work',
  editIntro: 'Changes are written as your current identity, and each one is recorded with a receipt.',
  noAuthorityTitle: 'You can’t edit this Work',
  noAuthorityBody: 'Editing needs edit authority on this Work. Ask its maintainers to appoint you.',
  signInTitle: 'Sign in to edit', signInBody: 'Choose an identity with edit authority on this Work to change its structure.',

  saved: 'Saved', receipt: insert('Receipt: {{receipt}}', { receipt: String }),
  replayed: 'This exact change had already been recorded.',
  pendingTitle: 'Still being applied',
  pendingBody: 'Send the same form again in a moment; it will not be applied twice.',
  mainSays: 'Reason', reload: 'Reload latest',
  problemSignIn: 'Sign in again to make this change',
  problemDenied: 'You can’t make this change',
  problemStale: 'This Work changed since you opened the page',
  problemInvalid: 'This wasn’t accepted',
  problemConflict: 'This conflicts with what is already recorded',
  problemUnavailable: 'Couldn’t be reached',
  staleBody: 'Your input is kept. Reload to see the latest version, then send it again.',
  unavailableBody: 'Nothing was changed. Try again in a moment.',
  badWork: 'This page does not name a Work.', badIntent: 'That control did not say what to change.',
  badStructure: 'This Work has no list of parts yet; add a part to start one.',
  badTarget: 'Name the Work by its address or ID.', badLabel: 'Give a label of 1 to 500 characters.',
  badAfter: 'Choose where the part goes.', badKind: 'Choose a relation.',
  badCounterpart: 'Name another Work by its address or ID.',
  badEvidence: 'Give an https address that shows the evidence.',
  badLanguage: 'Use a language tag such as ja, en or zh-Hans.',
  badTranslators: 'Name each Agent by its ID, separated by spaces.',
  badPublishers: 'Name each Agent by its ID, separated by spaces.',
  badTitle: 'Give a title of 1 to 500 characters.', badStatus: 'Choose a status.',
  badIsbn13: 'An ISBN-13 has 13 digits and starts with 978 or 979.', badYear: 'Use a year such as 2009.',
  badTerritory: 'Use a two-letter country code or a three-digit region code.',
  badIdentifiers: 'Write each identifier as an https provider address, a space, then its value.',
  badCoverage: 'Choose at least one realization the release carries.',

  partsHeading: 'Parts', partsList: 'Parts in publication order',
  partsHelp: 'The order here is the publication order readers see. Labels are this Work’s own numbering.',

  addPart: 'Add a part',
  partTarget: 'Work', partTargetHelp: 'Search by title, or paste the Work’s address or ID.',
  partLabel: 'Label', partLabelHelp: 'As this Work numbers it, for example 22 or SS1.',
  partInclusion: 'Inclusion', inclusionRequired: 'Required', inclusionOptional: 'Optional', inclusionExtra: 'Extra',
  partPlace: 'Place', placeFirst: 'At the start', placeLast: 'At the end',
  placeAfter: insert('After {{label}}', { label: String }),
  addPartButton: 'Add part',
  moveUp: insert('Move {{label}} up', { label: String }), moveDown: insert('Move {{label}} down', { label: String }),
  removePart: insert('Remove {{label}}', { label: String }),
  removeConfirm: 'Remove this part from the list? The Work itself stays.', removeButton: 'Remove',
  editPart: insert('Edit {{label}}', { label: String }), savePart: 'Save',
  moreParts: 'Next parts', firstParts: 'Back to the first parts',
  unlabelled: 'Unlabelled',

  relationsHeading: 'Relations', recordRelation: 'Record a relation',
  relationsHelp: 'Say how this Work relates to another, with evidence. The other Work’s own page shows it from its side.',
  relKind: 'This Work is', relKindHelp: 'Each relation is worded for you.',
  relCounterpart: 'The other Work', relCounterpartHelp: 'Search by title, or paste the Work’s address or ID.',
  relEvidence: 'Evidence', relEvidenceHelp: 'An https address that shows it, such as a publisher’s page.',
  relUnresolved: 'The other Work’s version is not known',
  relUnresolvedHelp: 'Record the link without pinning the version it came from.',
  recordButton: 'Record relation', 
  noKindsBody: 'No relation kinds were offered. Try again later.',
  currentRelations: 'Recorded relations',

  editionsHeading: 'Editions',
  addRealization: 'Add a realization',
  realizationHelp: 'A realization is one text: the original, a translation or a cut, with its own translators.',
  language: 'Language', languageHelp: 'A language tag such as ja, en or zh-Hans.',
  realizationKind: 'Kind', kindOriginal: 'Original', kindTranslation: 'Translation',
  translatorMe: 'I am the translator',
  translators: 'Other translators', translatorsHelp: 'Agent IDs, separated by spaces.',
  publishers: 'Publishers', publishersHelp: 'Agent IDs, separated by spaces. Optional.',
  realizationSource: 'Translated from',
  sourceUnresolved: 'Not known yet', sourceMainVersion: 'This Work’s Main Version',
  sourceRealization: insert('{{language}} realization', { language: String }),
  realizationStatus: 'Status', statusOfficial: 'Official', statusUnofficial: 'Unofficial',
  verification: 'Verification', verified: 'Verified', unverified: 'Unverified',
  realizationEvidence: 'Evidence', realizationEvidenceHelp: 'Needed for an official or verified realization.',
  addRealizationButton: 'Add realization',

  addRelease: 'Add a release',
  releaseHelp: 'A release is something published or distributed. It can cover realizations of several Works.',
  releaseTitle: 'Title', releaseTitleLanguage: 'Title language',
  releaseKind: 'Kind', releaseFormal: 'Published edition', releaseWeb: 'Web publication', releaseFixed: 'Fixed file',
  releaseVirtual: 'Virtual',
  releaseStatus: 'Status', statusVirtual: 'Virtual', statusWithdrawn: 'Withdrawn', statusCancelled: 'Cancelled',
  platform: 'Format or platform', platformHelp: 'For example paperback, ebook or Kindle.',
  territory: 'Territory', territoryHelp: 'A two-letter country code or a three-digit region code.',
  publisher: 'Publisher', publicationYear: 'Publication year', editionStatement: 'Edition statement',
  isbn13: 'ISBN-13', identifiers: 'Other identifiers',
  identifiersHelp: 'One per line: an https provider address, a space, then the value.',
  coverage: 'What it covers',
  coverageHelp: 'Tick every realization this release carries. An omnibus ticks realizations of several Works.',
  coverageCompleteness: 'How much of each', coverageComplete: 'Complete', coveragePartial: 'Partial',
  coverageTrial: 'Trial', coverageUnknown: 'Unknown', coveragePortion: 'Portion label',
  coveragePortionHelp: 'Optional, for example Vol. 1–3.',
  coverageWorkHeading: insert('Realizations of {{work}}', { work: String }),
  coverageThisWork: 'This Work’s realizations',
  coverageMore: 'Cover another Work’s realizations',
  coverageLoad: 'Load its realizations', coverageNone: 'No realizations found for that Work.',
  coverageFailed: 'Could not load that Work’s realizations.',
  noRealizationsYet: 'Add a realization before a release: a release always covers at least one.',
  addReleaseButton: 'Add release',
  currentEditions: 'Recorded realizations and releases',

  pickerChosen: insert('Chosen: {{title}}', { title: String }), pickerClear: 'Clear',
  pickerSuggestions: 'Matching Works',
  pickerFound: plural({ one: insert('{{count}} matching Work'), other: insert('{{count}} matching Works') },
    { count: asValue(number()) }),

  submitting: 'Saving…',
};

export const englishMessages = en;
export type WorkLevelsEditMessages = typeof en;

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

/** The interface strings of one locale, ready to call (`t.pickerFound(3)`). */
export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type Copy = ReturnType<typeof copyOf>;
