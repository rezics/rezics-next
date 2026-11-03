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

// Consume the installed generated client bodies for both statistic operations.
type SourceStatisticsClient = ReturnType<ReturnType<KernelClient['subjects']>['source-statistics']>;
type GeneratedStatisticValue = Readonly<Parameters<SourceStatisticsClient['put']>[0]>;
type GeneratedClearValue = Readonly<Parameters<SourceStatisticsClient['$clear']['post']>[0]>;
type GeneratedStatisticList = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['subjects']>['source-statistics']['get']>>['data']
>;
type GeneratedPublicFigure = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['subjects']>['figure']['get']>>['data']
>;
/** Content's observation CAS is additive on the generated VNDB bodies. */
export type ImportObservationToken = Readonly<{ expectedObservation?: string | null }>;
export type ImportSourceStatisticValue = GeneratedStatisticValue & ImportObservationToken;
export type ImportSourceStatistic = ImportSourceStatisticValue & Readonly<{ source: 'vndb' }>;
export type ImportSourceStatisticClearValue = GeneratedClearValue & ImportObservationToken;
export type ImportSourceStatisticClear = ImportSourceStatisticClearValue & Readonly<{ source: 'vndb' }>;
export type ImportSourceStatisticFigure = GeneratedStatisticList[number] &
  Readonly<{ observation?: { kind: 'unversioned'; digest: string } }>;
export type ImportPublicFigure = GeneratedPublicFigure extends { figure: infer Figure }
  ? Figure
  : GeneratedPublicFigure;

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
  readSourceStatistics?(
    input: { subjectId: string },
    signal?: AbortSignal,
  ): Promise<readonly ImportSourceStatisticFigure[]>;
  readPublicFigure?(input: { subjectId: string }, signal?: AbortSignal): Promise<ImportPublicFigure>;
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

export type StagingCaptureIdentity = Readonly<{
  sha256: string;
  bytes: number;
  sourceAlias: string;
  sourceKind: SourceId;
  converterRevision: string;
  decoderId: string;
  checkpointVersion: number;
  disappearanceThreshold: number;
}>;

export type StagingCheckpointRequest = Readonly<{
  action: 'acquire' | 'resume';
  generation?: string;
  identity: StagingCaptureIdentity;
}>;

export type RunOptions = Readonly<{
  source: string;
  converter_revision: string;
  disappearanceThreshold?: number;
}>;

export type SourceDestinationProvenance = 'first-use' | 'operator-declared';
export type ImportDestination = Readonly<{ origin: string }>;
export type { SourceDestinationBinding } from './source-destination.ts';

export type { ConversionDiagnosticPhase, SanitizedConversionDiagnostic } from './conversion-diagnostics.ts';
export type { OpenLibraryDumpSetAdmission, OpenLibraryDumpSetMember } from './open-library-dump-set.ts';
export type { OpenLibraryDumpFamily } from './dumps.ts';

export type RunStatus =
  | 'committed'
  | 'invalid-dump'
  | 'mass-disappearance'
  | 'bulk-failed'
  | 'interrupted'
  | 'busy'
  | 'observation-conflict';

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

export type ImportProgressPhase =
  | 'acquiring'
  | 'verifying'
  | 'loading'
  | 'validating'
  | 'publishing'
  | 'materializing'
  | 'staging'
  | 'resuming'
  | 'reconciling'
  | 'deferred-media'
  | 'finalizing'
  | 'committed'
  | 'invalid-input'
  | 'mass-disappearance'
  | 'busy'
  | 'interrupted'
  | 'denied'
  | 'failed'
  | 'observation-conflict';

export type ImportProgressKind = 'new' | 'changed' | 'unchanged' | 'vanished';
export type ImportMediaProgress = 'deferred' | 'rejected';

/** In-memory hooks at real source, run-store and acknowledgement transitions. */
export type ImportProgressObserver = Readonly<{
  onPhase?(phase: ImportProgressPhase): void | Promise<void>;
  onRun?(runId: string, resumed: boolean): void;
  onStaged?(count: number): void;
  onVerifiedPrefix?(count: number): void;
  onSourceCompleted?(): void;
  onAcknowledgedEffects?(count: number): void;
  onClassified?(kind: ImportProgressKind): void;
  onSkipped?(count: number): void;
  onMedia?(outcome: ImportMediaProgress): void;
}>;
