import type {
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
  PublicFilterQueriedObservation,
} from './public-filter-consumer-contract.ts';
import type {
  PrivacyReductionStart,
  PublicFilterConsumer,
  PublicFilterCost,
  PublicFilterDependencyKey,
  PublicFilterProjectionMeaning,
} from '../semantic/public-filter-source-contract.ts';
import type { OpenSearch } from './opensearch.ts';

/** Structural Source data copied by trusted producers; custody never certifies Source authority. */
export type CustodyDefinition = Readonly<{
  source: Readonly<{ id: string; partition: number; epoch: number; configuration: string }>;
  readDefinition: string;
  meaning: PublicFilterProjectionMeaning;
  capture: PublicFilterConsumerCaptureInput;
  dependencyKeys: readonly PublicFilterDependencyKey[];
}>;
export type CustodyRegistration = Readonly<{ partition: number; id: string }>;
export type CustodyExecution = Readonly<{
  id: string;
  start: PrivacyReductionStart;
  ownRows: readonly Readonly<{ original: string; terminal: string }>[];
}>;
/** Durable bounded lease: the producer must release in finally, including failed native work. */
export type CustodyUse = Readonly<{ observation: string; token: string }>;
export type CustodyCost = PublicFilterCost &
  Readonly<{ statements: number; rows: number; bytes: number; engineRequests: number }>;
export type CustodyFailure = Readonly<{
  status: 'unready' | 'unavailable';
  reason:
    | 'source_missing'
    | 'configuration_changed'
    | 'definition_missing'
    | 'observation_lost'
    | 'execution_missing'
    | 'binding_mismatch'
    | 'owner_unavailable'
    | 'identity_pending'
    | 'deadline';
  cost: CustodyCost;
}>;
export type CustodyFound = Readonly<{
  status: 'found';
  definition: CustodyDefinition;
  queried: PublicFilterQueriedObservation;
  covered: PrivacyReductionStart;
  execution: CustodyExecution | null;
  cost: CustodyCost;
}>;
export type CustodyRetained = Readonly<{
  status: 'retained';
  queried: PublicFilterQueriedObservation;
  cost: CustodyCost;
}>;
export type CustodyRead = Readonly<{ queried: PublicFilterQueriedObservation; execution?: string }>;
export interface PublicFilterCustody {
  register(
    request: Readonly<{
      definition: CustodyDefinition;
      physicalTarget: string;
      consumerGeneration: string;
      projectionGeneration: string;
    }>,
    search: OpenSearch,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{
        status: 'registered';
        registration: CustodyRegistration;
        consumer: PublicFilterConsumer;
        cost: CustodyCost;
      }>
    | CustodyFailure
  >;
  openPit(
    request: Readonly<{ registration: CustodyRegistration; covered: PrivacyReductionStart; keepAliveMs: number }>,
    search: OpenSearch,
    context: PublicFilterConsumerContext,
  ): Promise<CustodyRetained | CustodyFailure>;
  /** Immutable SQL prepared input owned by this observation, not a mutable cache or population proof. */
  retainPrepared(
    request: Readonly<{
      registration: CustodyRegistration;
      covered: PrivacyReductionStart;
      build: string;
      generation: bigint;
      rows: CustodyExecution['ownRows'];
      expiresAt: number;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<CustodyRetained | CustodyFailure>;
  acquire(
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
  ): Promise<Readonly<{ status: 'acquired'; use: CustodyUse; cost: CustodyCost }> | CustodyFailure>;
  appendExecution(
    request: Readonly<{ use: CustodyUse; execution: CustodyExecution }>,
    context: PublicFilterConsumerContext,
  ): Promise<Readonly<{ status: 'appended'; cost: CustodyCost }> | CustodyFailure>;
  release(
    use: CustodyUse,
    context: PublicFilterConsumerContext,
  ): Promise<Readonly<{ status: 'released'; cost: CustodyCost }> | CustodyFailure>;
  renewPit(
    queried: PublicFilterQueriedObservation,
    keepAliveMs: number,
    search: OpenSearch,
    context: PublicFilterConsumerContext,
  ): Promise<CustodyRetained | CustodyFailure>;
  closeObservation(
    queried: PublicFilterQueriedObservation,
    search: OpenSearch,
    context: PublicFilterConsumerContext,
  ): Promise<Readonly<{ status: 'closed'; cost: CustodyCost }> | CustodyFailure>;
  retire(
    registration: CustodyRegistration,
    context: PublicFilterConsumerContext,
  ): Promise<Readonly<{ status: 'retired'; cost: CustodyCost }> | CustodyFailure>;
  read(request: CustodyRead, context: PublicFilterConsumerContext): Promise<CustodyFound | CustodyFailure>;
  /** Drains local method calls; committed observations survive factory recovery. Supplied resources stay open. */
  close(): Promise<void>;
}
