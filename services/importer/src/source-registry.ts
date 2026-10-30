import { SourceSchema } from '@rezics/definitions/bulk';
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
import type { ConversionInput, SourceId } from '@rezics/conversion';
import type { ConversionContext } from '../../../packages/conversion/src/support.ts';
import type {
  ImportConversion,
  ImportSourceStatistic,
  ImportSourceStatisticClear,
  SourceRegistration,
} from './import-contract.ts';

/** Typed source asset leaves are passed through from modules that define them. */
export type SourceAssets = {
  readonly coverAssets: Omit<MediaImportRequest, 'containerId'>[];
  readonly mediaImportIntents: MediaImportRequest[];
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

function addAliases(result: NativeConversion, sourceAlias: string): ImportConversion<SourceAssets> {
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
  return {
    ...result,
    normalized: result.normalizedRecord,
    coverAssets,
    mediaImportIntents,
    ...(sourceStatistic === undefined ? {} : { sourceStatistic }),
    ...(sourceStatisticClear === undefined ? {} : { sourceStatisticClear }),
  };
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
    convert(input, context) {
      if (context.source !== source) throw new TypeError('Conversion context source differs from registration');
      const result = native.convert(input, context, { converterRevision });
      return addAliases(result, source);
    },
  };
}
