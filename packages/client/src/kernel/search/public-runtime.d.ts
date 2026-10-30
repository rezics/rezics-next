import type { Pool } from 'pg';
import { type SearchGenerationPublication } from './generation-publication.ts';
import type { Access } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { type PublicSuggestionOperations } from './public-suggestion.ts';
import type { PublicFilterConsumerCapture, PublicFilterConsumerCaptureInput, PublicFilterConsumerContext, PublicFilterConsumerJob, PublicFilterConsumerOperations, PublicSuggestionCaptureInput } from './public-filter-consumer-contract.ts';
import type { OpenSearch } from './opensearch.ts';
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
    publication: SearchGenerationPublication;
    bindRequest(request: Readonly<{
        plan: PublicFilterConsumerCaptureInput;
        snapshot: 'pit' | 'prepared';
    }>, context: PublicFilterConsumerContext): Promise<BoundPublicRequest>;
    bindSuggestion(request: PublicSuggestionCaptureInput, context: PublicFilterConsumerContext): Promise<Readonly<{
        operations: PublicSuggestionOperations;
        capture: PublicFilterConsumerCapture;
    }>>;
    repair(job: PublicFilterConsumerJob, context: PublicFilterConsumerContext): ReturnType<PublicFilterConsumerOperations['repairStep']>;
    close(): Promise<void>;
}>;
/** Trusted default composition. Neither Source nor Actor nor physical identity is injectable. */
export declare function createDefaultPublicFilterRuntime(config: DefaultPublicFilterRuntimeConfig): DefaultPublicFilterRuntime;
