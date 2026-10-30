import type { BatchCommand, BatchWriteRequest, BatchWriteResult, FieldGroup } from '@rezics/definitions/bulk';
import type { ConversionInput, ConvertedRecord, SourceId } from '@rezics/conversion';
import type { ConversionContext } from '../../../packages/conversion/src/support.ts';

export type ImportBatchRequest = BatchWriteRequest;
export type ImportBatchResult = BatchWriteResult;

export type ImportSourceStatistic = Readonly<{
  source: 'vndb';
  sourceRecordId: string;
  scale: Readonly<{ min: number; max: number }>;
  mean: number;
  count: number;
  asOf: string;
  licence: string;
  attribution: string;
}>;

export type ImportSourceStatisticValue = Omit<ImportSourceStatistic, 'source'>;

export type ImportSourceStatisticClear = Readonly<{
  source: 'vndb';
  sourceRecordId: string;
  count: 0;
  asOf: string;
}>;
export type ImportSourceStatisticClearValue = Omit<ImportSourceStatisticClear, 'source'>;

export interface ImportTransport {
  batchWrite(request: ImportBatchRequest): Promise<ImportBatchResult>;
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
