import type { SourceId } from '@rezics/conversion';
import { converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import {
  converter_revision as crossMediaRevision,
  bangumiRecordUrl,
  vndbRecordUrl,
} from '@rezics/conversion/cross-media-entities';
import { converter_revision as openLibraryRevision } from '@rezics/conversion/open-library';
import { converter_revision as vndbRevision } from '@rezics/conversion/vndb';
import { converter_revision as wikidataRevision } from '@rezics/conversion/wikidata';
import { SourceSchema } from '@rezics/definitions/bulk';
import type { ImportSourceRecord } from './import-contract.ts';

/** Trusted alias plus native converter identity. Source records cannot choose either. */
export type SourceIdentityAdmission = Readonly<{
  sourceKind: SourceId;
  defaultAlias: string;
  identityPattern: RegExp;
}>;

/** Active converter revision referenced by ordinary CLI and selected-family callers. */
export type SourceRevisionAdmission = Readonly<{
  converter_revision: string;
  selectedConverterRevision?: string;
}>;

/** Reviewed metadata rights only. Cover and prose permissions stay converter-owned. */
export type SourceRightsAdmission = Readonly<{
  name: string;
  licence: { readonly id: string; readonly url: string };
  attribution: string;
}>;

/** Logical input envelope used before acquisition. Dump bytes and pages stay on the reader. */
export type SourceBoundsAdmission = Readonly<{
  dumpFormat: 'jsonl' | 'tsv' | 'copy-archive' | 'jsonl-gzip';
  compression: readonly ('none' | 'gzip' | 'zstd')[];
  projectionBytes: number;
}>;

export type SourceAdmission = Readonly<{
  identity: SourceIdentityAdmission;
  revision: SourceRevisionAdmission;
  rights: SourceRightsAdmission;
  bounds: SourceBoundsAdmission;
  recordUrl(externalId: string): string;
  describeSourceRecord(externalId: string): ImportSourceRecord;
}>;

const cc0 = Object.freeze({ id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' });
const bangumiIdentity = /^(?:(?:character|person|episode):)?[1-9][0-9]*$/u;
const vndbIdentity = /^[vcsrp][1-9][0-9]*$/u;
const openLibraryIdentity = /^\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M)$/u;
const wikidataIdentity = /^Q[1-9][0-9]*$/u;

function requireIdentity(pattern: RegExp, externalId: string, message: string): void {
  if (!pattern.test(externalId)) throw new TypeError(message);
}

function rightsRecord(admission: SourceRightsAdmission, url: string): ImportSourceRecord {
  return { name: admission.name, url, licence: { ...admission.licence }, attribution: admission.attribution };
}

const bangumiRights: SourceRightsAdmission = Object.freeze({
  name: 'Bangumi',
  licence: Object.freeze({ id: 'CC-BY-SA-3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' }),
  attribution: 'Bangumi contributors',
});

const vndbRights: SourceRightsAdmission = Object.freeze({
  name: 'VNDB',
  licence: Object.freeze({ id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' }),
  attribution: 'VNDB (database: ODbL-1.0; permitted metadata contents: DbCL-1.0)',
});

const openLibraryRights: SourceRightsAdmission = Object.freeze({
  name: 'Open Library',
  licence: cc0,
  attribution: 'Open Library contributors',
});

const wikidataRights: SourceRightsAdmission = Object.freeze({
  name: 'Wikidata',
  licence: cc0,
  attribution: 'Wikidata contributors',
});

/** Ordinary Bangumi subjects, people, characters and episodes. */
export const bangumiSourceAdmission: SourceAdmission = Object.freeze({
  identity: Object.freeze({
    sourceKind: 'bangumi',
    defaultAlias: 'bangumi',
    identityPattern: bangumiIdentity,
  }),
  revision: Object.freeze({
    converter_revision: bangumiRevision,
    selectedConverterRevision: `${crossMediaRevision}+${bangumiRevision}`,
  }),
  rights: bangumiRights,
  bounds: Object.freeze({
    dumpFormat: 'jsonl',
    compression: Object.freeze(['none'] as const),
    projectionBytes: 64 * 1024,
  }),
  recordUrl: bangumiRecordUrl,
  describeSourceRecord(externalId) {
    requireIdentity(bangumiIdentity, externalId, 'Invalid Bangumi record identity');
    return rightsRecord(bangumiRights, bangumiRecordUrl(externalId));
  },
});

/** Ordinary VNDB COPY works, releases, staff, producers and characters. */
export const vndbSourceAdmission: SourceAdmission = Object.freeze({
  identity: Object.freeze({
    sourceKind: 'vndb',
    defaultAlias: 'vndb',
    identityPattern: vndbIdentity,
  }),
  revision: Object.freeze({ converter_revision: vndbRevision, selectedConverterRevision: crossMediaRevision }),
  rights: vndbRights,
  bounds: Object.freeze({
    dumpFormat: 'copy-archive',
    compression: Object.freeze(['zstd'] as const),
    projectionBytes: 64 * 1024,
  }),
  recordUrl: (externalId) => vndbRecordUrl(externalId),
  describeSourceRecord(externalId) {
    requireIdentity(vndbIdentity, externalId, 'Invalid VNDB record identity');
    return rightsRecord(vndbRights, vndbRecordUrl(externalId));
  },
});

/** Open Library five-column TSV Work and Edition rows. */
export const openLibrarySourceAdmission: SourceAdmission = Object.freeze({
  identity: Object.freeze({
    sourceKind: 'openlibrary',
    defaultAlias: 'open-library',
    identityPattern: openLibraryIdentity,
  }),
  revision: Object.freeze({ converter_revision: openLibraryRevision }),
  rights: openLibraryRights,
  bounds: Object.freeze({
    dumpFormat: 'tsv',
    compression: Object.freeze(['gzip'] as const),
    projectionBytes: 2 * 1024 * 1024,
  }),
  recordUrl: (externalId) => `https://openlibrary.org${externalId}`,
  describeSourceRecord(externalId) {
    requireIdentity(openLibraryIdentity, externalId, 'Invalid Open Library record identity');
    return rightsRecord(openLibraryRights, `https://openlibrary.org${externalId}`);
  },
});

/** Wikidata JSONL Q-items with genuine lastrevid. */
export const wikidataSourceAdmission: SourceAdmission = Object.freeze({
  identity: Object.freeze({
    sourceKind: 'wikidata',
    defaultAlias: 'wikidata',
    identityPattern: wikidataIdentity,
  }),
  revision: Object.freeze({ converter_revision: wikidataRevision }),
  rights: wikidataRights,
  bounds: Object.freeze({
    dumpFormat: 'jsonl-gzip',
    compression: Object.freeze(['gzip', 'zstd'] as const),
    projectionBytes: 128 * 1024,
  }),
  recordUrl: (externalId) => `https://www.wikidata.org/wiki/${externalId}`,
  describeSourceRecord(externalId) {
    requireIdentity(wikidataIdentity, externalId, 'Invalid Wikidata record identity');
    return rightsRecord(wikidataRights, `https://www.wikidata.org/wiki/${externalId}`);
  },
});

/** Four launch sources as declared values. CLI and seed bind these; dumps cannot choose them. */
export const admittedSourceAdmissions: Readonly<Record<SourceId, SourceAdmission>> = Object.freeze({
  bangumi: bangumiSourceAdmission,
  vndb: vndbSourceAdmission,
  openlibrary: openLibrarySourceAdmission,
  wikidata: wikidataSourceAdmission,
});

export const selectedFamilyAliases = Object.freeze({
  bangumi: 'bangumi_cross_media',
  vndb: 'vndb_cross_media',
} as const);

export const selectedFamilyRevisions = Object.freeze({
  bangumi: `${crossMediaRevision}+${bangumiRevision}`,
  vndb: crossMediaRevision,
} as const);

/** Adapter revisions used by selected publication without loading those producer modules. */
export const selectedAdapterRevisions = Object.freeze({
  vndbStaffCredits: 'vndb-staff-credits@1',
  vndbWorkLinks: 'vndb-work-links@2',
  vndbCharacterVocabulary: 'vndb-character-vocabulary@1',
  vndbCharacterProfileVocabulary: 'vndb-character-profile-vocabulary@1',
  vndbPublicTagVocabulary: 'vndb-public-tag-vocabulary@2',
} as const);

export const crossMediaBangumiRevision = selectedFamilyRevisions.bangumi;

type SourceField = 'source' | 'converter_revision';
type StringConstraint = { minLength?: number; maxLength?: number; pattern?: string };

/** Portable source-envelope field syntax. Callers supply the alias and revision they bound. */
export function validateSourceField(field: SourceField, value: unknown): asserts value is string {
  const constraint = SourceSchema.properties[field] as StringConstraint;
  if (
    typeof value !== 'string' ||
    value.length < (constraint.minLength ?? 0) ||
    value.length > (constraint.maxLength ?? Number.POSITIVE_INFINITY) ||
    (constraint.pattern !== undefined && new RegExp(constraint.pattern, 'u').exec(value)?.[0] !== value)
  )
    throw new TypeError(`Invalid source ${field}`);
}

export function sourceAdmissionFor(kind: SourceId): SourceAdmission {
  const admission = admittedSourceAdmissions[kind];
  if (!admission) throw new TypeError('Unknown source kind');
  return admission;
}

export function selectedFamilyAdmission(kind: 'bangumi' | 'vndb'): SourceAdmission {
  const base = admittedSourceAdmissions[kind];
  const alias = selectedFamilyAliases[kind];
  const revision = selectedFamilyRevisions[kind];
  return Object.freeze({
    ...base,
    identity: Object.freeze({ ...base.identity, defaultAlias: alias }),
    revision: Object.freeze({ ...base.revision, converter_revision: revision }),
  });
}
