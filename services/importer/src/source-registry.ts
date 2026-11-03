import { BATCH_LIMIT, SourceSchema } from '@rezics/definitions/bulk';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import {
  converter_revision as bangumiRevision,
  convertBangumi,
  type BangumiConversion,
} from '@rezics/conversion/bangumi';
import { converter_revision as vndbRevision, convertVndb, type VndbConversion } from '@rezics/conversion/vndb';
import {
  converter_revision as wikidataRevision,
  convertWikidata,
  type WikidataConversion,
} from '@rezics/conversion/wikidata';
import {
  converter_revision as openLibraryRevision,
  convertOpenLibrary,
  type OpenLibraryConversion,
} from '@rezics/conversion/open-library';
import { mapBangumiVocabulary } from '@rezics/conversion/bangumi-vocabulary';
import { mapVndbVocabulary } from '@rezics/conversion/vndb-vocabulary';
import type { SourceVocabularyGap, SourceVocabularyInput } from '@rezics/conversion';
import type { ConversionInput, SourceId } from '@rezics/conversion';
import type { ConversionContext } from '../../../packages/conversion/src/support.ts';
import type {
  ImportConversion,
  ImportSourceStatistic,
  ImportSourceStatisticClear,
  ImportSourceRecord,
  SourceRegistration,
} from './import-contract.ts';

/** Typed source asset leaves are passed through from modules that define them. */
export type SourceAssets = {
  readonly coverAssets: Omit<MediaImportRequest, 'containerId'>[];
  readonly mediaImportIntents: MediaImportRequest[];
  readonly sourceVocabularyGaps?: readonly SourceVocabularyGap[];
};

type NativeConversion = BangumiConversion | VndbConversion | WikidataConversion | OpenLibraryConversion;

// This importer consumes the pinned VNDB dump declared in packages/definitions/sources/vndb.yaml.
const VNDB_DUMP_AS_OF = '2026-10-25';

type NativeSource = Readonly<{
  source: string;
  converter_revision: string;
  convert(
    input: ConversionInput,
    context: ConversionContext,
    options: { readonly converterRevision: string },
  ): NativeConversion;
}>;

const nativeSources: Readonly<Record<SourceId, NativeSource>> = {
  bangumi: {
    source: 'bangumi',
    converter_revision: bangumiRevision,
    convert: convertBangumi,
  },
  vndb: {
    source: 'vndb',
    converter_revision: vndbRevision,
    convert: convertVndb,
  },
  wikidata: {
    source: 'wikidata',
    converter_revision: wikidataRevision,
    convert: convertWikidata,
  },
  openlibrary: {
    source: 'open-library',
    converter_revision: openLibraryRevision,
    convert: convertOpenLibrary,
  },
};

/** Reviewed metadata rights only; prose and cover permissions remain converter-owned. */
function describeSourceRecord(kind: SourceId, id: string): ImportSourceRecord {
  const cc0 = { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  switch (kind) {
    case 'bangumi':
      if (!/^[1-9][0-9]*$/.test(id)) throw new TypeError('Invalid Bangumi record identity');
      return {
        name: 'Bangumi',
        url: `https://bgm.tv/subject/${id}`,
        licence: { id: 'CC-BY-SA-3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
        attribution: 'Bangumi contributors',
      };
    case 'vndb':
      if (!/^v[1-9][0-9]*$/.test(id)) throw new TypeError('Invalid VNDB record identity');
      return {
        name: 'VNDB',
        url: `https://vndb.org/${id}`,
        licence: { id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
        attribution: 'VNDB (database: ODbL-1.0; permitted metadata contents: DbCL-1.0)',
      };
    case 'openlibrary':
      if (!/^\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M)$/.test(id))
        throw new TypeError('Invalid Open Library record identity');
      return {
        name: 'Open Library',
        url: `https://openlibrary.org${id}`,
        licence: cc0,
        attribution: 'Open Library contributors',
      };
    case 'wikidata':
      if (!/^Q[1-9][0-9]*$/.test(id)) throw new TypeError('Invalid Wikidata record identity');
      return {
        name: 'Wikidata',
        url: `https://www.wikidata.org/wiki/${id}`,
        licence: cc0,
        attribution: 'Wikidata contributors',
      };
  }
}

type SourceField = 'source' | 'converter_revision';
type StringConstraint = { minLength?: number; maxLength?: number; pattern?: string };

function validateSourceField(field: SourceField, value: unknown): asserts value is string {
  const constraint = SourceSchema.properties[field] as StringConstraint;
  if (
    typeof value !== 'string' ||
    value.length < (constraint.minLength ?? 0) ||
    value.length > (constraint.maxLength ?? Number.POSITIVE_INFINITY) ||
    (constraint.pattern !== undefined && new RegExp(constraint.pattern, 'u').exec(value)?.[0] !== value)
  )
    throw new TypeError(`Invalid source ${field}`);
}

function addAliases(
  result: NativeConversion,
  sourceAlias: string,
  sourceKind: SourceId,
  context: ConversionContext,
): ImportConversion<SourceAssets> {
  const coverAssets = 'coverAssets' in result ? result.coverAssets : [];
  const mediaImportIntents = 'mediaImportIntents' in result ? result.mediaImportIntents : [];
  let sourceStatistic: ImportSourceStatistic | undefined;
  let sourceStatisticClear: ImportSourceStatisticClear | undefined;
  if (result.source === 'vndb' && 'vn' in result.normalizedRecord) {
    const count = result.normalizedRecord.vn.c_votecount;
    const average = result.normalizedRecord.vn.c_average;
    if (count === 0 && average !== undefined) {
      sourceStatisticClear = {
        source: 'vndb',
        ...(sourceAlias === 'vndb' ? {} : { sourceAlias }),
        sourceRecordId: result.normalizedRecord.vn.id,
        count: 0,
        asOf: VNDB_DUMP_AS_OF,
      };
    }
    if (count !== undefined && count > 0 && average !== undefined && average !== null && average >= 100) {
      sourceStatistic = {
        source: 'vndb',
        ...(sourceAlias === 'vndb' ? {} : { sourceAlias }),
        sourceRecordId: result.normalizedRecord.vn.id,
        scale: { min: 1, max: 10 },
        mean: average / 100,
        count,
        asOf: VNDB_DUMP_AS_OF,
        licence: 'ODbL-1.0',
        attribution: 'VNDB',
      };
    }
  }
  const vocabulary = context.sourceVocabulary && (sourceKind === 'bangumi' || sourceKind === 'vndb')
    ? sourceVocabularyResult(result, sourceAlias, sourceKind, context.sourceVocabulary)
    : undefined;
  return {
    ...result,
    ...(vocabulary === undefined ? {} : {
      proposals: [...result.proposals, ...vocabulary.proposals],
      diagnostics: [
        ...result.diagnostics,
        ...vocabulary.gaps.map((gap) => ({ pointer: gap.path, code: gap.reason, sourceVocabularyGap: gap })),
      ],
      sourceVocabularyGaps: vocabulary.gaps,
    }),
    normalized: result.normalizedRecord,
    coverAssets,
    mediaImportIntents,
    ...(sourceStatistic === undefined ? {} : { sourceStatistic }),
    ...(sourceStatisticClear === undefined ? {} : { sourceStatisticClear }),
  };
}

function sourceVocabularyResult(
  result: NativeConversion,
  sourceAlias: string,
  sourceKind: 'bangumi' | 'vndb',
  request: NonNullable<ConversionContext['sourceVocabulary']>,
) {
  const metadata = describeSourceRecord(sourceKind, result.external_id);
  const recordUrl = sourceKind === 'bangumi'
    ? (result as BangumiConversion).sourceMetadata.recordUrl
    : `https://vndb.org/${result.external_id}.${result.record_revision}`;
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
    rows: request.rows,
    commandLimit: Math.max(0, BATCH_LIMIT - result.proposals.length),
  };
  return sourceKind === 'bangumi' ? mapBangumiVocabulary(input) : mapVndbVocabulary(input);
}

/** Register one of the four pure native converters under trusted application metadata. */
export function createSourceRegistration(
  sourceKind: SourceId,
  options?: { source?: string; converterRevision?: string },
): SourceRegistration<SourceAssets> {
  if (!Object.hasOwn(nativeSources, sourceKind)) throw new TypeError('Unknown source kind');
  const native = nativeSources[sourceKind];
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options)))
    throw new TypeError('Invalid source registration options');
  const source = options?.source === undefined ? native.source : options.source;
  const converterRevision =
    options?.converterRevision === undefined ? native.converter_revision : options.converterRevision;
  validateSourceField('source', source);
  validateSourceField('converter_revision', converterRevision);

  return {
    sourceKind,
    source,
    converter_revision: converterRevision,
    describeSourceRecord: (externalId) => describeSourceRecord(sourceKind, externalId),
    convert(input, context) {
      if (context.source !== source) throw new TypeError('Conversion context source differs from registration');
      const result = native.convert(input, context, { converterRevision });
      return addAliases(result, source, sourceKind, context);
    },
  };
}
