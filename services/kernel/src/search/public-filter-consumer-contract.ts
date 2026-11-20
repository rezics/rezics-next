import type { Pool } from 'pg';
import type { PublicFilterSourceBinding } from '../semantic/index.ts';
import type {
  PublicFilterConsumerContext,
  PublicFilterConsumerUnavailable,
  PublicFilterQueriedObservation,
} from '../semantic/index.ts';
import type { DiscoveryConsumerCaptureInput, DiscoveryConsumerQuery, DiscoveryRegistry } from './discovery.ts';
import type { FilterDocument } from '@rezics/filter';
import type { TextNode } from './text.ts';
import type { KernelClock } from '../clock.ts';
import type {
  PublicFilterConsumer,
  PublicFilterCost,
  PublicFilterProjectionMeaning,
  PublicFilterSource,
  PrivacyReductionHead,
  PrivacyReductionStart,
} from '../semantic/index.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SearchPlan, SearchResult, SubjectHit } from './query.ts';
import type { CreditSearchSource } from './credit-search.ts';

/** Native mixed preparation advances one bounded page before saving its durable frontier. */
export const PUBLIC_FILTER_PREPARATION_BATCH_SIZE = 100;
/** Raw mixed candidates include duplicates and current-predicate rejects. */
export const PUBLIC_FILTER_PREPARATION_RAW_LIMIT = 1_000;

export type { PublicFilterConsumerContext, PublicFilterConsumerUnavailable, PublicFilterQueriedObservation };

/** Shared semantic input, never a compiled-only admission. All inherited native DSL/metadata
 * fields are optional compatibility evidence and must match the plan derived from this AST.
 * Undefined explicitly means no filter/text; order, size and keyset retain Search semantics.
 */
export type PublicFilterConsumerCaptureInput = Readonly<
  SearchPlan & {
    filterDocument: FilterDocument | undefined;
    text: TextNode | undefined;
    /** Requested public slots, independent of derived native batch size. Legacy callers default to size. */
    pageSize?: number;
  }
>;

/** Prefix is its own canonical semantic input, never a TextNode or caller DSL. */
export type PublicSuggestionCaptureInput = Readonly<{
  purpose: 'suggest';
  prefix: string;
  size: number;
  generation?: number;
  filterDocument: undefined;
  text: undefined;
}>;

/** Retained by the same custody registry and resolved by the same native Source definition. */
export type PublicCanonicalCaptureInput =
  | PublicFilterConsumerCaptureInput
  | DiscoveryConsumerCaptureInput
  | (PublicSuggestionCaptureInput & Readonly<{ after?: never }>);

export type PublicSuggestionQuery =
  | (Omit<Extract<PublicFilterConsumerQuery, { status: 'queried' }>, 'result' | 'window'> &
      Readonly<{ result: readonly SubjectHit[] }>)
  | Exclude<PublicFilterConsumerQuery, { status: 'queried' }>;

/** Locator of persisted native repair work, not an input/frontier or completion assertion. */
export type PublicFilterConsumerJob = Readonly<{ consumer: PublicFilterConsumer; job: string }>;

export type PublicFilterConsumerCapture =
  | Readonly<{ status: 'preparing'; repair: PublicFilterConsumerJob; cost: PublicFilterCost }>
  | Readonly<{
      status: 'captured';
      queried: PublicFilterQueriedObservation;
      repair: PublicFilterConsumerJob;
      cost: PublicFilterCost;
    }>
  | PublicFilterConsumerUnavailable;

/** Consume a raw prefix of a retained execution; only the producer resolves native keys. */
export type PublicFilterConsumerRefill = Readonly<{ execution: string; consumed: number; size: number }>;

/** Ordinals in THIS execution, including rejected/duplicate/lookahead raw candidates. */
export type PublicFilterConsumerWindow = Readonly<{
  positions: readonly number[];
  examined: number;
  exhausted: boolean;
}>;

export type PublicFilterConsumerQuery =
  | Readonly<{
      status: 'queried';
      /** Same immutable observation; only a validated native PIT renewal may alter its PIT locator. */
      queried: PublicFilterQueriedObservation;
      /** Retained actual plan, start, original/terminal own-row set and engine execution. */
      execution: string;
      start: PrivacyReductionStart;
      result: SearchResult;
      window: PublicFilterConsumerWindow;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'preparing'; queried: PublicFilterQueriedObservation; cost: PublicFilterCost }>
  | PublicFilterConsumerUnavailable;

/** Diagnostic only. None of these fields lets a caller publish an ACK or a public response. */
export type PublicFilterConsumerStatus =
  | Readonly<{
      status: 'observed';
      queried: PublicFilterQueriedObservation;
      /** Cut retained with THIS immutable observation, never the newer live target's ACK. */
      covered: PrivacyReductionStart;
      pending: readonly PrivacyReductionHead[];
      changed: readonly PrivacyReductionHead[];
      blocking: readonly Readonly<{
        head: PrivacyReductionHead;
        scope: 'filter_or_order' | 'returned_subject' | 'unresolved';
        phase: 'pending' | 'changed';
      }>[];
      cost: PublicFilterCost;
    }>
  | PublicFilterConsumerUnavailable;

export type PublicFilterConsumerRepair =
  | Readonly<{
      status: 'progress' | 'settled';
      job: PublicFilterConsumerJob;
      cost: PublicFilterCost;
    }>
  | PublicFilterConsumerUnavailable;

/** Closed native boundary; there is no ACK setter, caller repair input or Boolean evaluator. */
export interface PublicFilterConsumerOperations {
  captureDiscovery?(
    request: Readonly<{ plan: DiscoveryConsumerCaptureInput; snapshot: 'pit' | 'prepared' }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerCapture>;
  queryDiscovery?(
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
    refill?: PublicFilterConsumerRefill,
  ): Promise<DiscoveryConsumerQuery>;
  capture(
    request: Readonly<{ plan: PublicCanonicalCaptureInput; snapshot: 'pit' | 'prepared' }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerCapture>;
  query(
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
    refill?: PublicFilterConsumerRefill,
  ): Promise<PublicFilterConsumerQuery>;
  repairStep(job: PublicFilterConsumerJob, context: PublicFilterConsumerContext): Promise<PublicFilterConsumerRepair>;
  readStatus(
    request: Readonly<{ queried: PublicFilterQueriedObservation; execution?: string }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerStatus>;
  /** Releases only this retained observation/PIT, after in-flight operations drain. Idempotent. */
  closeObservation(queried: PublicFilterQueriedObservation, context: PublicFilterConsumerContext): Promise<void>;
  /** Drains this factory's work/resources; does not close supplied pools, Source or OpenSearch. */
  close(): Promise<void>;
}

/** Full same-factory view; legacy Subject consumers need only the original operations. */
export interface PublicDiscoveryConsumerOperations extends PublicFilterConsumerOperations {
  captureDiscovery(
    request: Readonly<{ plan: DiscoveryConsumerCaptureInput; snapshot: 'pit' | 'prepared' }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerCapture>;
  queryDiscovery(
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
    refill?: PublicFilterConsumerRefill,
  ): Promise<DiscoveryConsumerQuery>;
}

/** Injected native consumer. Source and binding remain supplied owner resources. */
export type PublicFilterConsumerOperationsFactory = (
  config: Readonly<{
    pool: Pool;
    source: PublicFilterSource;
    creditSearch?: CreditSearchSource;
    binding: PublicFilterSourceBinding;
    registry?: DiscoveryRegistry;
    search: OpenSearch;
    clock: KernelClock;
    context: PublicFilterConsumerContext;
    physicalTarget: string;
    meaning: PublicFilterProjectionMeaning;
  }>,
) => Promise<PublicDiscoveryConsumerOperations>;
