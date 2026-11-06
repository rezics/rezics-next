import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { BATCH_LIMIT } from '@rezics/definitions/bulk';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { convertBangumi, type BangumiConversion } from '@rezics/conversion/bangumi';
import { convertVndb, type VndbConversion } from '@rezics/conversion/vndb';
import { convertWikidata, type WikidataConversion } from '@rezics/conversion/wikidata';
import { convertOpenLibrary, type OpenLibraryConversion } from '@rezics/conversion/open-library';
import {
  convertCrossMediaEntity,
  crossMediaEntityKind,
  mapSourceEnumeration,
} from '@rezics/conversion/cross-media-entities';
import { mapBangumiVocabulary } from '@rezics/conversion/bangumi-vocabulary';
import { mapVndbVocabulary } from '@rezics/conversion/vndb-vocabulary';
import type {
  ConversionDiagnostic,
  ConversionContext,
  ConversionInput,
  NativeIdentity,
  SourceId,
  SourceVocabularyGap,
  SourceVocabularyInput,
  SourceVocabularyRow,
} from '@rezics/conversion';
import { projectSourceClassification } from '@rezics/conversion';
import type { ImportConversion, ImportSourceStatistic, ImportSourceStatisticClear, SourceRegistration } from './import-contract.ts';
import {
  admittedSourceAdmissions,
  crossMediaBangumiRevision,
  selectedFamilyAdmission,
  selectedFamilyRevisions,
  sourceAdmissionFor,
  validateSourceField,
  type SourceAdmission,
} from './registration-contract.ts';

/** Typed source asset leaves are passed through from modules that define them. */
export type SourceAssets = {
  readonly coverAssets: Omit<MediaImportRequest, 'containerId'>[];
  readonly mediaImportIntents: MediaImportRequest[];
  readonly sourceVocabularyGaps?: readonly SourceVocabularyGap[];
};

type NativeConversion = BangumiConversion | VndbConversion | WikidataConversion | OpenLibraryConversion;

type VocabularySource = {
  readonly external_id: string;
  readonly digest: string;
  readonly record_revision: string | null;
  readonly converter_revision: string;
  readonly proposals: NativeConversion['proposals'];
  readonly sourceMetadata?: unknown;
  readonly normalizedRecord?: Record<string, unknown>;
};

type NativeConverter = Readonly<{
  convert(
    input: ConversionInput,
    context: ConversionContext,
    options: { readonly converterRevision: string },
  ): NativeConversion;
}>;

/** Converter functions bound once at the composition root. Admissions stay in registration-contract. */
export const admittedConverterBindings: Readonly<Record<SourceId, NativeConverter>> = Object.freeze({
  bangumi: Object.freeze({ convert: convertBangumi }),
  vndb: Object.freeze({ convert: convertVndb }),
  wikidata: Object.freeze({ convert: convertWikidata }),
  openlibrary: Object.freeze({ convert: convertOpenLibrary }),
});

export { crossMediaBangumiRevision, admittedSourceAdmissions };
const isCrossMediaBangumiRevision = (value: string) => /^cross-media-entities@\d+\+bangumi@\d+$/u.test(value);

/** Project statistics only with the acquisition's admitted snapshot date. */
export function vndbSourceStatistics(
  normalized: unknown,
  sourceAlias: string,
  sourceSnapshotAsOf?: string,
): Pick<ImportConversion, 'sourceStatistic' | 'sourceStatisticClear'> {
  const record = normalized as { vn?: { id: string; c_votecount?: number; c_average?: number | null } };
  let sourceStatistic: ImportSourceStatistic | undefined;
  let sourceStatisticClear: ImportSourceStatisticClear | undefined;
  if (sourceSnapshotAsOf !== undefined && record.vn) {
    const count = record.vn.c_votecount;
    const average = record.vn.c_average;
    if (count === 0 && average !== undefined) {
      sourceStatisticClear = {
        source: 'vndb',
        ...(sourceAlias === 'vndb' ? {} : { sourceAlias }),
        sourceRecordId: record.vn.id,
        count: 0,
        asOf: sourceSnapshotAsOf,
      };
    }
    if (count !== undefined && count > 0 && average !== undefined && average !== null && average >= 100) {
      sourceStatistic = {
        source: 'vndb',
        ...(sourceAlias === 'vndb' ? {} : { sourceAlias }),
        sourceRecordId: record.vn.id,
        scale: { min: 1, max: 10 },
        mean: average / 100,
        count,
        asOf: sourceSnapshotAsOf,
        licence: 'ODbL-1.0',
        attribution: 'VNDB',
      };
    }
  }
  return { ...(sourceStatistic ? { sourceStatistic } : {}), ...(sourceStatisticClear ? { sourceStatisticClear } : {}) };
}

function addAliases(
  result: NativeConversion,
  sourceAlias: string,
  sourceKind: SourceId,
  context: ConversionContext,
  sourceSnapshotAsOf?: string,
): ImportConversion<SourceAssets> {
  const coverAssets = 'coverAssets' in result ? result.coverAssets : [];
  const mediaImportIntents = 'mediaImportIntents' in result ? result.mediaImportIntents : [];
  const statistics =
    sourceKind === 'vndb' ? vndbSourceStatistics(result.normalizedRecord, sourceAlias, sourceSnapshotAsOf) : {};
  const vocabulary =
    context.sourceVocabulary && (sourceKind === 'bangumi' || sourceKind === 'vndb')
      ? sourceVocabularyResult(result, sourceAlias, sourceKind, context.sourceVocabulary, context)
      : undefined;
  return {
    ...result,
    ...(vocabulary === undefined
      ? {}
      : {
          proposals: [...result.proposals, ...vocabulary.proposals],
          diagnostics: [
            ...result.diagnostics,
            ...vocabulary.gaps.map((gap) => ({ pointer: gap.path, code: gap.reason, sourceVocabularyGap: gap })),
          ],
          sourceVocabularyGaps: vocabulary.gaps,
          sourceVocabulary: vocabulary.request,
        }),
    normalized: result.normalizedRecord,
    coverAssets: [...coverAssets],
    mediaImportIntents: [...mediaImportIntents],
    ...statistics,
    ...(context.sourceClassification === undefined
      ? {}
      : { sourceClassification: projectSourceClassification(context.sourceClassification) }),
  };
}

function sourceVocabularyResult(
  result: VocabularySource,
  sourceAlias: string,
  sourceKind: 'bangumi' | 'vndb',
  request: NonNullable<ConversionContext['sourceVocabulary']>,
  context: ConversionContext,
) {
  const admission = sourceAdmissionFor(sourceKind);
  const metadata = admission.describeSourceRecord(result.external_id);
  const recorded =
    'sourceMetadata' in result && result.sourceMetadata && typeof result.sourceMetadata === 'object'
      ? (result.sourceMetadata as { recordUrl?: unknown }).recordUrl
      : undefined;
  const recordUrl =
    typeof recorded === 'string' && recorded
      ? recorded
      : sourceKind === 'bangumi'
        ? admission.recordUrl(result.external_id)
        : `https://vndb.org/${result.external_id}.${result.record_revision}`;
  const rows: SourceVocabularyRow[] = [...request.rows];
  if (sourceKind === 'bangumi' && context.subjectId && result.normalizedRecord) {
    const normalized = result.normalizedRecord;
    const nativeType = mapSourceEnumeration('bangumi', 'person.type', normalized.type as number)?.term;
    const career = normalized.career;
    if ((nativeType === 'schema:Person' || nativeType === 'schema:Organization') && Array.isArray(career)) {
      const identity: NativeIdentity = { id: context.subjectId, type: nativeType, releaseDigest: bundledDigest };
      const explicit = new Map(
        rows
          .filter((row): row is Extract<SourceVocabularyRow, { kind: 'person-career' }> => row.kind === 'person-career')
          .map((row) => [`${row.path}\0${row.code}`, row]),
      );
      for (const code of career) {
        if (typeof code !== 'string') continue;
        const key = `/career\0${code}`;
        if (!explicit.has(key)) explicit.set(key, { kind: 'person-career', person: identity, code, path: '/career' });
      }
      for (const [key, row] of explicit) if (row.person === undefined) explicit.set(key, { ...row, person: identity });
      rows.splice(0, rows.length, ...rows.filter((row) => row.kind !== 'person-career'), ...explicit.values());
    }
  }
  const input: SourceVocabularyInput = {
    metadata: {
      provider: sourceKind,
      sourceAlias,
      externalId: result.external_id,
      recordRevision: result.record_revision,
      digest: result.digest,
      converterRevision: result.converter_revision,
      recordUrl,
      license: metadata.licence?.id ?? '',
      attribution: metadata.attribution ?? '',
    },
    bindings: request.bindings,
    rows,
    commandLimit: Math.max(0, BATCH_LIMIT - result.proposals.length),
  };
  return sourceKind === 'bangumi' ? mapBangumiVocabulary(input) : mapVndbVocabulary(input);
}

export type SourceRegistrationOptions = {
  source?: string;
  converterRevision?: string;
  sourceSnapshotAsOf?: string;
};

/** Bind one declared admission to its released converter. CLI and seed construct this explicitly. */
export function bindSourceRegistration(
  admission: SourceAdmission,
  options?: SourceRegistrationOptions,
): SourceRegistration<SourceAssets> {
  const sourceKind = admission.identity.sourceKind;
  const native = admittedConverterBindings[sourceKind];
  if (!native) throw new TypeError('Unknown source kind');
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options)))
    throw new TypeError('Invalid source registration options');
  const source = options?.source === undefined ? admission.identity.defaultAlias : options.source;
  const converterRevision =
    options?.converterRevision === undefined ? admission.revision.converter_revision : options.converterRevision;
  validateSourceField('source', source);
  validateSourceField('converter_revision', converterRevision);
  return {
    sourceKind,
    source,
    converter_revision: converterRevision,
    describeSourceRecord: (externalId) => admission.describeSourceRecord(externalId),
    convert(input, context) {
      if (context.source !== source) throw new TypeError('Conversion context source differs from registration');
      if (sourceKind === 'bangumi' || sourceKind === 'vndb') {
        const kind = crossMediaEntityKind(sourceKind, input.external_id, input.record);
        if (
          kind &&
          (kind === 'bangumi-person' ||
            converterRevision === selectedFamilyRevisions.vndb ||
            converterRevision === selectedFamilyRevisions.bangumi ||
            (sourceKind === 'bangumi' && isCrossMediaBangumiRevision(converterRevision)))
        ) {
          const entity = convertCrossMediaEntity(input, context, { converterRevision, sourceKind });
          const base: ImportConversion<SourceAssets> = {
            ...entity,
            normalized: entity.normalizedRecord,
            ...(sourceKind === 'vndb'
              ? vndbSourceStatistics(entity.normalizedRecord, source, options?.sourceSnapshotAsOf)
              : {}),
            coverAssets: [...entity.coverAssets],
            mediaImportIntents: [...entity.mediaImportIntents],
          };
          if (!context.sourceVocabulary) return base;
          const vocabulary = sourceVocabularyResult(entity, source, sourceKind, context.sourceVocabulary, context);
          return {
            ...base,
            proposals: [...entity.proposals, ...vocabulary.proposals],
            diagnostics: [
              ...entity.diagnostics,
              ...vocabulary.gaps.map((gap) => ({ pointer: gap.path, code: gap.reason, sourceVocabularyGap: gap })),
            ],
            sourceVocabularyGaps: vocabulary.gaps,
            sourceVocabulary: vocabulary.request,
          };
        }
      }
      const result = native.convert(input, context, { converterRevision });
      return addAliases(result, source, sourceKind, context, options?.sourceSnapshotAsOf);
    },
  };
}

/** Ordinary four-provider registration from the declared admission table. */
export function createSourceRegistration(
  sourceKind: SourceId,
  options?: SourceRegistrationOptions,
): SourceRegistration<SourceAssets> {
  return bindSourceRegistration(sourceAdmissionFor(sourceKind), options);
}

/** Selected-family Bangumi records use a revision that tracks both native and entity conversion. */
export function createSelectedFamilySourceRegistration(
  sourceKind: 'bangumi' | 'vndb',
  source: string,
): SourceRegistration<SourceAssets> {
  return bindSourceRegistration(selectedFamilyAdmission(sourceKind), {
    source,
    converterRevision: selectedFamilyRevisions[sourceKind],
  });
}

/**
 * A bound conversion sends only the statements that the released profile of its native subject type admits. A
 * statement outside that profile is withheld with a property_not_admitted diagnostic instead of being sent to be
 * refused by Kernel. Unknown native types leave the conversion unchanged, and the converter output and revision stay
 * as converted.
 */
export function admitBoundProposals<Extra extends object>(
  registration: SourceRegistration<Extra>,
  nativeTypeOf: (externalId: string) => string | undefined,
): SourceRegistration<Extra> {
  return {
    ...registration,
    convert(input, context) {
      const result = registration.convert(input, context);
      const nativeType = context.subjectId === undefined ? undefined : nativeTypeOf(input.external_id);
      const profile = nativeType === undefined ? undefined : bundledRelease.types[nativeType];
      if (!profile) return result;
      const withheld: ConversionDiagnostic[] = [];
      const proposals = result.proposals.filter((command, index) => {
        if (command.op !== 'propose' || profile.properties.includes(command.statement.property.id)) return true;
        withheld.push({ pointer: `/proposals/${index}/statement/property/id`, code: 'property_not_admitted' });
        return false;
      });
      if (withheld.length === 0) return result;
      return { ...result, proposals, diagnostics: [...result.diagnostics, ...withheld] };
    },
  };
}

/**
 * The released BookSeries profile admits no Bangumi identifier, so a numeric BookSeries key is identified by its durable
 * source tuple (configured alias plus exact external ID), as Organizations are, instead of by wdt:P5732.
 */
export function isBookSeriesSourceTuple(key: string, nativeType: string | undefined): boolean {
  return /^[1-9][0-9]*$/u.test(key) && nativeType === 'schema:BookSeries';
}
