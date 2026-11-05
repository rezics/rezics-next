import type { RetainedSearchContinuation } from './cursor.ts';
import type { SearchHit } from './query.ts';
import { type RetainedUsefulPage } from './useful-page.ts';
import type { Pool } from 'pg';
import type { DiscoveryRegistry } from './discovery.ts';
import { type SearchGenerationPublication } from './generation-publication.ts';
import type { Access } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { type PublicSuggestionOperations } from './public-suggestion.ts';
import type { PublicFilterConsumerCapture, PublicFilterConsumerCaptureInput, PublicFilterConsumerContext, PublicFilterConsumerJob, PublicFilterConsumerOperations, PublicDiscoveryConsumerOperations, PublicFilterQueriedObservation, PublicSuggestionCaptureInput } from './public-filter-consumer-contract.ts';
import type { OpenSearch } from './opensearch.ts';
import type { FacetDiscoveryProvider } from './facet-discovery-native.ts';
export type DefaultPublicFilterRuntimeConfig = Readonly<{
    pool: Pool;
    routeKey: Uint8Array;
    access: Access;
    search: OpenSearch;
    prefix: string;
    clock: KernelClock;
}>;
export type BoundPublicRequest = Readonly<{
    operations: PublicFilterConsumerOperations;
    capture: PublicFilterConsumerCapture;
}>;
export type DefaultPublicFilterRuntime = Readonly<{
    /** Pins the active mixed physical allocation; retained roots must still address that allocation. */
    openDiscovery(registry: DiscoveryRegistry, digest: string, context: PublicFilterConsumerContext, queried?: PublicFilterQueriedObservation): Promise<PublicDiscoveryConsumerOperations>;
    publication: SearchGenerationPublication;
    preparePublication(generation: number, context: PublicFilterConsumerContext): ReturnType<SearchGenerationPublication['prepare']>;
    bindRequest(request: Readonly<{
        plan: PublicFilterConsumerCaptureInput;
        snapshot: 'pit' | 'prepared';
    }>, context: PublicFilterConsumerContext): Promise<BoundPublicRequest>;
    /** Reopen a factory for retained producer state without recapturing or resetting its allowance. */
    resumeRequest(queried: PublicFilterQueriedObservation, context: PublicFilterConsumerContext): Promise<PublicFilterConsumerOperations>;
    bindSuggestion(request: PublicSuggestionCaptureInput, context: PublicFilterConsumerContext): Promise<Readonly<{
        operations: PublicSuggestionOperations;
        capture: PublicFilterConsumerCapture;
    }>>;
    repair(job: PublicFilterConsumerJob, context: PublicFilterConsumerContext): ReturnType<PublicFilterConsumerOperations['repairStep']>;
    /** Trusted native facet composition; omitted generation or meaning stays closed. */
    facetProvider(): Promise<FacetDiscoveryProvider | undefined>;
    close(): Promise<void>;
}>;
/** Trusted default composition. Neither Source nor Actor nor physical identity is injectable. */
export declare function createDefaultPublicFilterRuntime(config: DefaultPublicFilterRuntimeConfig): DefaultPublicFilterRuntime;
export type PublicSearchRead<T> = Readonly<{
    page: RetainedUsefulPage<T>;
    continuation: RetainedSearchContinuation;
    /** Must follow ALL response/source/summary work, even on an exhausted empty page. */
    finalize: () => Promise<void>;
    /** Releases exhausted observations only, after final disclosure has completed. */
    release: () => Promise<void>;
    /** Always called by the response owner, including hydration/cursor/final failures. */
    dispose: () => Promise<void>;
}>;
/** Execute against ONE native captured observation, never against a live alias.
 * Native methods enforce SQL/point/byte/search ceilings across this root, including
 * final authority. This layer additionally limits rounds and actual raw window work.
 */
export declare function readPublicSearchPage<T>(options: {
    operations: PublicFilterConsumerOperations;
    plan: PublicFilterConsumerCaptureInput;
    context: PublicFilterConsumerContext;
    continuation?: RetainedSearchContinuation;
    /** The default runtime already performed the actual bound capture. */
    capture?: PublicFilterConsumerCapture;
    /** Existing durable preparation delivery, when installed by the host. */
    prepare?: (job: PublicFilterConsumerJob) => Promise<void>;
    /** A trusted planner choice. Prepared is the conservative default, not a claim of readiness. */
    snapshot?: 'pit' | 'prepared';
    check: (hits: readonly SearchHit[]) => Promise<ReadonlyMap<SearchHit, T>>;
    canonicalId: (value: T) => string;
}): Promise<PublicSearchRead<T>>;
