import { insert, materializeData } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface copy for the generic resource page. What a thing is called comes
// from the type registry, and relation labels from Main's lexicon; neither is
// written here.
const en = {
  alternateSelf: "Alternate self",
  otherWorldCounterpart: "Counterpart from another world",
  identityGlobal: "Global",
  identityRealm: "Community",
  oneRatingUntilMean: "1 more rating will reveal the average.",
  variantFamily: "Other versions",
  identityHub: "Main entry",
  variantOf: "Main entry",
  units: "Units",
  represents: "Represents",
  titlesHeld: "Titles held",
  titleHolders: "Holders",
  noVariants: "No variants are listed here.",
  noUnits: "No units are listed here.",
  noRepresented: "No represented characters are listed here.",
  noTitles: "No titles are listed here.",
  noHolders: "No holders are listed here.",
  visibleRelationsOnly: "Only relations visible at your reading position are listed.",
  moreIdentityRelations: "More relations",
  identityRatingsUnavailable: "Ratings could not be loaded.",
  noRatingQuestion: "No rating question in this scope.",
  ratingsUntilMean: insert("{{count}} more ratings will reveal the average.", { count: String }),
  unknownVariantKind: "Other version",
  titleContextUnavailable: "Where this title is held could not be shown.",
  pageUnavailableTitle: 'This page can’t be shown right now',
  pageUnavailableBody: 'REZICS could not reach this record. Try again in a moment.',
  notFoundTitle: 'Nothing here',
  notFoundBody: 'No resource has this address, or it is not visible to you.',
  restricted: 'Private', restrictedHelp: 'Only people granted access can see this.',

  holdsIn: 'Holds in',
  projectionFacts: 'What holds here',
  factsHere: 'Stated for this exact place',
  factsWider: 'Stated for a wider setting that includes it',
  factsEverywhere: 'Holds everywhere',
  statements: 'Statements', statementsUnavailable: 'Statements could not be loaded.',
  noStatements: 'No statements yet', noStatementsBody: 'Nothing has been accepted about this yet.',
  otherFacts: 'Other facts',
  statementsList: 'Statements',
  valueSome: 'Unknown value', valueNone: 'No value',
  relations: 'Relations', relationsUnavailable: 'Relations could not be loaded.',
  noRelations: 'No relations yet', noRelationsBody: 'Nothing is related to this yet.',
  discussion: 'Discussion',
  startDiscussion: insert('Discuss this {{subject}}', { subject: String }),
  ratingsFor: insert('Ratings for this {{subject}}', { subject: String }),
  reviewsFor: insert('Reviews of this {{subject}}', { subject: String }),
  noRatings: 'No ratings yet.',
  unavailable: 'Unavailable', unnamed: 'Unnamed', search: 'Search',
};

export const englishMessages = en;
export type EntityPageMessages = typeof en;

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

/** The interface strings of one locale, ready to call (`t.startDiscussion({ subject })`). */
export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type Copy = ReturnType<typeof copyOf>;

/** A registry label inside a sentence: lowercase in the languages that lowercase common nouns. */
export function inSentence(label: string, locale: UiLocale): string {
  return locale === 'en' || locale === 'fr' || locale === 'es' ? label.toLocaleLowerCase(locale) : label;
}
