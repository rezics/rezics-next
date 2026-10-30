import type { KernelClient } from '@rezics/client';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult, FieldGroup } from '@rezics/definitions/bulk';
import type { ConversionInput, ConvertedRecord, SourceId } from '@rezics/conversion';
import type { ConversionContext } from '../../../packages/conversion/src/support.ts';

export type ImportBatchRequest = BatchWriteRequest;
export type ImportBatchResult = BatchWriteResult;

// Consume the public generated operation, without importing a kernel runtime writer.
type MetadataClient = KernelClient['source-records']['$setMetadata'];
export type ImportSourceRecordMetadataCommand = Parameters<MetadataClient['post']>[0];
export type ImportSourceRecordMetadataResult = NonNullable<Awaited<ReturnType<MetadataClient['post']>>['data']>;
export type ImportSourceRecord = ImportSourceRecordMetadataCommand['metadata'];

/** Closed wire validation; callers snapshot data descriptors before invoking this. */
export function isImportSourceRecord(value: unknown): value is ImportSourceRecord {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const scalar = (v: unknown, max: number): v is string =>
    typeof v === 'string' &&
    v.length <= max &&
    v.trim().length > 0 &&
    v.isWellFormed() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
  const url = (v: unknown) => {
    if (!scalar(v, 2048) || /\s/u.test(v)) return false;
    try {
      const parsed = new URL(v);
      return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  };
  if (
    !object(value) ||
    Object.keys(value).some((k) => !['name', 'url', 'licence', 'attribution'].includes(k)) ||
    !scalar(value.name, 255) ||
    !url(value.url)
  )
    return false;
  if (Object.hasOwn(value, 'attribution') && !scalar(value.attribution, 500)) return false;
  if (Object.hasOwn(value, 'licence')) {
    if (
      !object(value.licence) ||
      !scalar(value.licence.id, 128) ||
      Object.keys(value.licence).some((k) => !['id', 'url'].includes(k)) ||
      (Object.hasOwn(value.licence, 'url') && !url(value.licence.url))
    )
      return false;
  }
  return true;
}

export function isImportSourceRecordMetadataResult(value: unknown): value is ImportSourceRecordMetadataResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).sort().join(',') === 'effect,metadata_revision,record' &&
    isImportSourceRecord(result.record) &&
    Number.isSafeInteger(result.metadata_revision) &&
    Number(result.metadata_revision) > 0 &&
    ['filled', 'corrected', 'noEffect'].includes(String(result.effect))
  );
}

// Consume the installed generated client bodies for both statistic operations.
type SourceStatisticsClient = ReturnType<ReturnType<KernelClient['subjects']>['source-statistics']>;
export type ImportSourceStatisticValue = Readonly<Parameters<SourceStatisticsClient['put']>[0]>;
export type ImportSourceStatistic = ImportSourceStatisticValue & Readonly<{ source: 'vndb' }>;
export type ImportSourceStatisticClearValue = Readonly<Parameters<SourceStatisticsClient['$clear']['post']>[0]>;
export type ImportSourceStatisticClear = ImportSourceStatisticClearValue & Readonly<{ source: 'vndb' }>;

export interface ImportTransport {
  batchWrite(request: ImportBatchRequest): Promise<ImportBatchResult>;
  setSourceRecordMetadata?(
    input: { command: ImportSourceRecordMetadataCommand; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<ImportSourceRecordMetadataResult>;
  readFence(tuple: {
    source: string;
    external_id: string;
    field_group: FieldGroup;
  }): Promise<{ fenced: boolean; securityRevision: string | null }>;
  clearSourceStatistic?(
    input: {
      subjectId: string;
      source: 'vndb';
      value: ImportSourceStatisticClearValue;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  writeSourceStatistic?(
    input: {
      subjectId: string;
      source: ImportSourceStatistic['source'];
      value: ImportSourceStatisticValue;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export type ImportConversionContext = Omit<ConversionContext, 'source'> & { readonly source: string };

/** A trusted converter registration; its configured source alias is supplied through context.source. */
export type SourceRegistration<Extra extends object = {}> = Readonly<{
  source: string;
  sourceKind: SourceId;
  converter_revision: string;
  /** Reviewed application descriptor. Community registrations have no implicit writer. */
  describeSourceRecord?(externalId: string): ImportSourceRecord;
  convert(input: ConversionInput, context: ImportConversionContext): ImportConversion<Extra>;
}>;

/** Sanitized converter output and portable commands, with room for typed downstream extensions. */
export type ImportConversion<Extra extends object = {}> = ConvertedRecord<BatchCommand> & {
  digest: string;
  normalized: unknown;
  sourceMetadata?: unknown;
  sourceStatistic?: ImportSourceStatistic;
  sourceStatisticClear?: ImportSourceStatisticClear;
} & Extra;

export type RunOptions = Readonly<{
  source: string;
  converter_revision: string;
  disappearanceThreshold?: number;
}>;

export type RunStatus = 'committed' | 'invalid-dump' | 'mass-disappearance' | 'bulk-failed' | 'interrupted' | 'busy';

/** Per-record state acknowledges one source record; a baseline describes the whole completed source run. */
export type RunResult = Readonly<{
  status: RunStatus;
  new: string[];
  changed: string[];
  unchanged: string[];
  vanished: string[];
  diagnostic: string;
}>;

export type RunResultSink = Readonly<{
  onNew?(sourceKey: string): void;
  onChanged?(sourceKey: string): void;
  onUnchanged?(sourceKey: string): void;
  onVanished?(sourceKey: string): void;
}>;

/** Production summaries can stream keys to a sink; explicit collection is for bounded diagnostics/tests. */
export type RunResultCollection = Readonly<{
  collect?: boolean;
  sink?: RunResultSink;
}>;
