import type { KindCataloguePin } from '@rezics/definitions';
import type {
  PublicCanonicalCaptureInput,
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
import type { AccountDiscoveryRepairObservation } from '../access/account-discovery-source.ts';
import type {
  PublicFilterSourceBinding,
  NativeSourceRepairLocator,
  PublicSourceRepair,
} from '../semantic/public-filter-source-binding.ts';

/** Structural Source data copied by trusted producers; custody never certifies Source authority. */
export type CustodyDefinition<Capture extends PublicCanonicalCaptureInput = PublicFilterConsumerCaptureInput> =
  Readonly<{
    source: Readonly<{ id: string; partition: number; epoch: number; configuration: string }>;
    readDefinition: string;
    meaning: PublicFilterProjectionMeaning;
    capture: Capture;
    dependencyKeys: readonly PublicFilterDependencyKey[];
  }>;
/** Exact immutable authority consumed through semantic.readRelease, including registered composites.
 * This locates complete meaning, never current Source permission or a reduced copy of its grammar.
 */
export type CustodyReleaseReference = Readonly<{
  authority: 'semantic.readRelease';
  digest: string;
}>;
/** Wide meanings retain their immutable authority instead of copying a four-MiB release into one MiB. */
export type CustodyRetainedDefinition = Omit<CustodyDefinition<PublicCanonicalCaptureInput>, 'meaning'> &
  Readonly<{
    meaning: Omit<PublicFilterProjectionMeaning, 'release'> &
      Readonly<{
        release: PublicFilterProjectionMeaning['release'] | CustodyReleaseReference;
      }>;
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
  definition: CustodyRetainedDefinition;
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
/** Only the native reader may return this opaque locator. It is never caller evidence. */
declare const privateProducerBrand: unique symbol;
export type NativePublicFilterRepairSettlement = Readonly<{ id: string; [privateProducerBrand]: true }>;
export type PublicFilterRepairSettlementResult =
  | CustodyFailure
  | Readonly<{
      status: 'settled';
      definition: CustodyRetainedDefinition;
      queried: PublicFilterQueriedObservation;
      execution: CustodyExecution;
      settlement: NativePublicFilterRepairSettlement;
      cost: CustodyCost;
    }>;
/** The original Source module owns repair verification and its durable locators. */
export type {
  NativeSourceRepairLocator,
  NativeSourceRepairRead,
  NativeSourceRepairVerification,
  NativeSourceRepairStepRead,
  NativeSourceRepairStepVerification,
} from '../semantic/public-filter-source-binding.ts';
export type PublicFilterRepairSourceBinding = PublicFilterSourceBinding;
export type RetainedSourceRepair = Omit<PublicSourceRepair, 'receipt'> &
  Readonly<{ receipt: NativeSourceRepairLocator }>;
/** Internal native storage shapes. Only data fields of the Source locator are persisted. */
export type RetainedRepairPage = Readonly<{
  /** Actual owner-native step locator, including the final step whose public frontier is null. */
  sourceStep: string;
  predecessor: string | null;
  frontier: string | null;
  complete: boolean;
  repairs: readonly RetainedSourceRepair[];
  /** Independent native Account input, never a Subject projection or privacy cause. */
  account?: AccountDiscoveryRepairObservation;
}>;
export type RetainedRepairSettlement = Readonly<{
  id: string;
  bootstrap: string;
  covered: PrivacyReductionStart;
  /** Same immutable parent execution; start and ownRows remain solely in its existing record. */
  execution: string;
  pages: number;
  frontier: string | null;
  closed: boolean;
  fence: Readonly<{
    transaction: string;
    incarnation: string;
    writeAlias: string;
    sourceEpoch: number;
    refresh: unknown;
  }> | null;
}>;
export interface PublicFilterCustody {
  register(
    request: Readonly<{
      definition: CustodyDefinition<PublicCanonicalCaptureInput>;
      physicalTarget: string;
      consumerGeneration: string;
      projectionGeneration: string;
      catalogue?: KindCataloguePin | null;
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
  /** Retain the actual query response locator under the existing active use, including malformed results. */
  retainPit(
    request: Readonly<{ use: CustodyUse; queried: PublicFilterQueriedObservation; pit: string }>,
    context: PublicFilterConsumerContext,
  ): Promise<CustodyRetained | CustodyFailure>;
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
