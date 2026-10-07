import { asValue, insert, materializeData, number, plural } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface copy for the parts, connections and editions pages. Relation
// labels are never here: Main renders them in the reader's language
// (docs/contracts/semantic-model.md#relation-lexicon).
const en = {
  parts: 'Parts', partsList: 'Parts in publication order', partsPages: 'Parts pages',
  partsUnavailable: 'Parts could not be loaded.',
  partOf: 'Part of', partOfList: 'Wholes that contain this Work',
  openGroup: 'Open group', allParts: 'All parts',
  noParts: 'No parts', noPartsBody: 'This Work has no ordered parts you can read.',
  inclusionOptional: 'Optional', inclusionExtra: 'Extra',
  completionConcluded: 'Concluded', completionOngoing: 'Ongoing', completionUnknown: 'Completion unknown',
  evidence: 'Evidence',

  connections: 'Connections', connectionsUnavailable: 'Connections could not be loaded.',
  allConnections: 'All connections',
  noConnections: 'No connections yet', noConnectionsBody: 'No franchise or relation names this Work yet.',
  relationsList: 'Relations', rolesList: 'Roles', relationsPages: 'Relations pages',
  relatedFallback: 'Related',
  creditedAs: 'as',
  nameNotShown: 'Name not shown',
  labelIn: insert('in {{language}}', { language: String }),
  unresolvedSource: 'Source version unresolved',
  unresolvedHint: 'The link is on record, but which revision of the source it follows is not.',
  franchises: 'Franchises', thisWork: 'This Work',
  grainLabel: 'Show', grainSwitch: 'Franchise level', grainSeries: 'Series', grainParts: 'Volumes and parts',
  noMembers: 'This franchise places no Works you can read.',
  membersUnavailable: 'This franchise’s members could not be loaded.',
  morePartsExist: 'More parts…',

  editions: 'Editions and releases', editionsUnavailable: 'Editions and releases could not be loaded.',
  allEditions: 'All editions and releases',
  realizations: 'Texts and translations', realizationsPages: 'Texts and translations pages',
  realizationsUnavailable: 'Texts and translations could not be loaded.',
  realizationUnavailable: 'The details of this text could not be read.',
  noRealizations: 'No texts recorded', noRealizationsBody: 'No text of this Work has been recorded in a language yet.',
  kindOriginal: 'Original text', kindTranslation: 'Translation',
  verified: 'Verified', unverified: 'Unverified',
  continuity: 'Source continuity', continuityFrom: 'Source text:',
  continuityMain: 'Main Version:', continuityOther: 'Another text of this Work',
  continuityUnresolved: 'Source not resolved yet',
  translators: 'Translators', publishers: 'Publishers', releasesOfText: 'Released in',
  releases: 'Releases', release: 'Release', releasesPages: 'Releases pages',
  releasesUnavailable: 'Releases could not be loaded.', releaseUnavailable: 'This release could not be shown.',
  noReleases: 'No releases', noReleasesBody: 'No release of this Work is on record yet.',
  kindFormal: 'Published edition', kindWeb: 'Web publication', kindFixed: 'Fixed release', kindVirtual: 'Virtual release',
  statusOfficial: 'Official', statusUnofficial: 'Unofficial', statusVirtual: 'Virtual',
  statusWithdrawn: 'Withdrawn', statusCancelled: 'Cancelled',
  withdrawnNotice: 'This release was withdrawn, so its text is unavailable. The release itself is still on record.',
  isbnMatches: 'Releases with this ISBN',
  identifiers: 'Identifiers', isbn: 'ISBN', platform: 'Platform', territory: 'Territory',
  languages: 'Languages', originalUrl: 'Original URL',
  coverage: 'Covers', coversHeading: 'What it covers', mainVersion: 'Main Version',
  coversWorks: plural({ one: insert('Covers {{count}} Work'), other: insert('Covers {{count}} Works') },
    { count: asValue(number()) }),
  coverageComplete: 'Complete', coveragePartial: 'Partial', coverageTrial: 'Trial', coverageUnknown: 'Coverage unknown',
  snapshotCount: plural({ one: insert('{{count}} web snapshot'), other: insert('{{count}} web snapshots') },
    { count: asValue(number()) }),

  showMore: 'Show more', firstPage: 'Back to the start',
  unavailable: 'Unavailable', unnamed: 'Unnamed',
};

export const englishMessages = en;
export type WorkLevelsMessages = typeof en;

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

/** The interface strings of one locale, ready to call (`t.coversWorks(3)`). */
export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type Copy = ReturnType<typeof copyOf>;
