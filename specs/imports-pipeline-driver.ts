import type { BatchWriteRequest } from '@rezics/definitions/bulk';
import type { ImportConversion } from '../services/importer/src/import-contract.ts';
import type { ImportRunResult } from '../services/importer/src/importer.ts';

/**
 * TEST ONLY. IMPORT_PIPELINE_DRIVER exports createImportPipelineDriver.
 * Build the real Importer (ImporterOptions, ImportRunOptions, ImportRunResult),
 * ImportSession/RunStore/RecordBindings, SourceRegistration and ImportConversion.
 * Clone the Bangumi fixture into real SourceRecord inputs, changing its numeric
 * id, revision/name and optional cover. Use the registered converter, never a
 * replacement planner. PipelineRecord and the controls below are test fixtures,
 * not proposed public importer interfaces. Forward recordConcurrency and
 * mediaDeadlineMs to importer options; do not implement scheduling in this driver.
 *
 * Wire recording ImportTransport and ImportMediaResolver with MediaImportPort
 * and the durable media journal. Fake only remote responses, identities and jobs.
 * Stable remote IDs depend on record identity, never allocation/completion order.
 * Preserve fake server effects and on-disk journals across reopen; keep factory
 * clocks/run identities deterministic across independent comparison fixtures.
 * cached means seed a real available journal; available means the POST's job is
 * immediately ready; after measures delay from that POST; pending needs a command.
 *
 * Drive injected clock/sleep through a discrete-event scheduler, never Date.now,
 * wall timers, real sleeps or sum-of-latencies time. Every request costs latencyMs;
 * completionOrder chooses ready request tie order (reverse reverses record keys).
 * Hooks run synchronously after remote completion, before returning to Importer.
 * Capture exact wire bytes/keys, actual sink/conversion order and journal record
 * acknowledgement times. Do not sort, synthesize outcomes or resolve pending
 * covers in the adapter. metadata is a non-bootstrap batch containing non-cover
 * proposals. phase identifies the actual staged/vanished/resumed/media pass.
 *
 * Observe actual retained importer record/projection/task/cover state, including
 * closures and queues, and page buffers. liveRecords counts unique retained record
 * identities; liveBytes includes projections and pending cover state. Exclude
 * SQLite persistence, streaming fixture input, result collection and test recorder
 * storage, not hidden importer arrays. No invented counters or process heap/RSS.
 * memory reports high-water marks over the whole run, including rejected/aborted
 * work. Test latency defaults to 5ms; collection defaults on for bounded fixtures.
 */
export const MISSING_PIPELINE_DRIVER =
  'IMPORT_PIPELINE_DRIVER is required: bind the real pipelined importer with virtual transport and media jobs';
export type PipelineRecord = { key: string; revision: number; cover?: boolean };
export type MediaMode = 'cached' | 'available' | 'pending' | 'rejected' | { after: number };
export type Phase = 'staged' | 'vanished' | 'resumed' | 'media';
export interface Exchange {
  recordKey: string;
  phase: Phase;
  kind: 'fence' | 'bulk' | 'media-post' | 'media-status';
  fieldGroup?: string;
  metadata: boolean;
  started: number;
  ended: number;
  /** Monotonic event sequence disambiguates starts/completions at the same time. */
  startOrder: number;
  endOrder: number;
  cancelled: boolean;
  bytes: string;
  keys: string[];
  request?: BatchWriteRequest;
}
export interface PipelineReport {
  result: ImportRunResult;
  observed: { kind: 'new' | 'changed' | 'unchanged' | 'vanished'; recordKey: string }[];
  conversions: { recordKey: string; output: ImportConversion }[];
  exchanges: Exchange[];
  acknowledgements: { recordKey: string; at: number }[];
  records: {
    recordKey: string;
    acknowledged: boolean;
    cover: 'proposed' | 'rejected' | 'fenced' | 'pending' | 'none';
  }[];
  elapsedMs: number;
  sleeps: { phase: Phase; ms: number }[];
  peakRecords: number;
  peakByPhase: Record<Phase, number>;
  activeRequestsAtEnd: number;
  memory: { liveRecords: number; liveBytes: number; stagedPageRecords: number };
}
export interface PipelineOptions {
  recordConcurrency?: number;
  mediaDeadlineMs?: number;
  latencyMs?: number;
  completionOrder?: 'forward' | 'reverse';
  media?: MediaMode;
  /** One non-bootstrap bulk response is a per-command error or invalid shape. */
  fault?: { recordKey: string; response: 'bulk-error' | 'invalid-response' };
}
export interface PipelineDriver {
  run(
    records: PipelineRecord[],
    options?: {
      signal?: AbortSignal;
      disappearanceThreshold?: number;
      onExchange?: (exchange: Exchange) => void;
      /** Real afterBulkSuccess fault, after server effect and before durable ack. */
      interruptAfterSuccess?: string;
      /** Disable collected keys/conversions/sinks for the growth measurement. */
      collect?: boolean;
    },
  ): Promise<PipelineReport>;
  setMedia(recordKey: string, state: 'available' | 'rejected' | 'pending'): void;
  setCoverFence(recordKey: string): void;
  /** Reopen the actual database, retaining remote state and omitted configuration. */
  reopen(options?: PipelineOptions): Promise<void>;
  effects(): Promise<{ subjects: number; proposals: number; retractions: number; duplicateEffects: number }>;
  close(): Promise<void>;
}
export type CreateImportPipelineDriver = (options: PipelineOptions & { directory: string }) => Promise<PipelineDriver>;
