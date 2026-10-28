import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type {
  PublicFilterConsumer,
  PublicFilterCost,
  PublicFilterProjectionMeaning,
  PublicFilterSource,
  PrivacyReductionHead,
  PrivacyReductionStart,
} from '../semantic/public-filter-source-contract.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SearchPlan, SearchResult } from './query.ts';

/** The ONE queried-observation type. Internal native locators, never public transport fields.
 * Each locator resolves to retained native execution/registration state; its shape proves nothing.
 */
export type PublicFilterQueriedObservation = Readonly<{
  consumer: PublicFilterConsumer;
  snapshot:
    | Readonly<{ kind: 'pit'; observation: string; pit: string }>
    | Readonly<{ kind: 'prepared'; observation: string; build: string; generation: bigint }>;
}>;

/** Actual caller request/worker deadline. Domain clock is installed once at the trusted factory. */
export type PublicFilterConsumerContext = Readonly<{ deadline: number }>;

/** Locator of persisted native repair work, not an input/frontier or completion assertion. */
export type PublicFilterConsumerJob = Readonly<{ consumer: PublicFilterConsumer; job: string }>;

export type PublicFilterConsumerUnavailable = Readonly<{
  status: 'unready' | 'unavailable';
  reason:
    | 'registration_missing'
    | 'incarnation_changed'
    | 'observation_lost'
    | 'source_pending'
    | 'routing_incomplete'
    | 'deadline'
    | 'dependency_unavailable';
  cost: PublicFilterCost;
}>;

export type PublicFilterConsumerCapture =
  | Readonly<{ status: 'preparing'; repair: PublicFilterConsumerJob; cost: PublicFilterCost }>
  | Readonly<{
      status: 'captured';
      queried: PublicFilterQueriedObservation;
      repair: PublicFilterConsumerJob;
      cost: PublicFilterCost;
    }>
  | PublicFilterConsumerUnavailable;

export type PublicFilterConsumerQuery =
  | Readonly<{
      status: 'queried';
      /** Same immutable observation; only a validated native PIT renewal may alter its PIT locator. */
      queried: PublicFilterQueriedObservation;
      /** Retained actual plan, start, original/terminal own-row set and engine execution. */
      execution: string;
      start: PrivacyReductionStart;
      result: SearchResult;
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
  capture(
    request: Readonly<{ plan: SearchPlan; snapshot: 'pit' | 'prepared' }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerCapture>;
  query(
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
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

/** Future search/public-filter-consumer.ts export createPublicFilterConsumerOperations: MISSING.
 * The target is a native physical name to resolve, never an incarnation/ACK supplied as truth.
 */
export type PublicFilterConsumerOperationsFactory = (
  config: Readonly<{
    pool: Pool;
    source: PublicFilterSource;
    search: OpenSearch;
    clock: KernelClock;
    context: PublicFilterConsumerContext;
    physicalTarget: string;
    meaning: PublicFilterProjectionMeaning;
  }>,
) => Promise<PublicFilterConsumerOperations>;
