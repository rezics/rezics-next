import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { PublicFilterConsumer } from '../semantic/index.ts';
import type { SearchNativePublicationCompletionReader, SearchPublicFilterCost, SearchPublicFilterProjectionMeaning, SearchPublicFilterSource, SearchPublicFilterSourceBinding, SearchPublicFilterSourceKeyPages } from './semantic-source-port.ts';
import type { PublicFilterConsumerContext, PublicFilterConsumerUnavailable } from './public-filter-consumer-contract.ts';
import type { SearchWriterPublicationGuard } from './writer-guard.ts';
import type { DiscoveryRegistry } from './discovery.ts';
import { type OpenSearch } from './opensearch.ts';
import type { CreditSearchSource } from './credit-search.ts';
export type GenerationPublicationJob = Readonly<{
    consumer: PublicFilterConsumer;
    job: string;
}>;
type HeldLane = 'capture' | 'source';
export type SearchGenerationPublication = Readonly<{
    prepare(consumer: PublicFilterConsumer, context: PublicFilterConsumerContext): Promise<{
        status: 'preparing';
        job: GenerationPublicationJob;
        cost: SearchPublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    step(job: GenerationPublicationJob, context: PublicFilterConsumerContext, options?: Readonly<{
        enrollSource: boolean;
        batchSource?: boolean;
        heldOffers?: number;
        heldLane?: HeldLane;
    }>): Promise<{
        status: 'progress' | 'reconciled';
        job: GenerationPublicationJob;
        cost: SearchPublicFilterCost;
        sourceAdvanced?: boolean;
        additionalEnrollmentCosts?: readonly SearchPublicFilterCost[];
    } | (PublicFilterConsumerUnavailable & {
        additionalEnrollmentCosts?: readonly SearchPublicFilterCost[];
    })>;
    activate(job: GenerationPublicationJob, context: PublicFilterConsumerContext, options?: Readonly<{
        batchSource: boolean;
    }>): Promise<{
        status: 'activated';
        consumer: PublicFilterConsumer;
        cost: SearchPublicFilterCost;
    } | {
        status: 'superseded';
        consumer: PublicFilterConsumer;
        cost: SearchPublicFilterCost;
    } | {
        status: 'preparing';
        job: GenerationPublicationJob;
        cost: SearchPublicFilterCost;
        next?: 'step' | 'activate';
        advanced?: boolean;
        sourceAdvanced?: boolean;
        additionalSourceCosts?: readonly SearchPublicFilterCost[];
    } | PublicFilterConsumerUnavailable>;
    close(): Promise<void>;
}>;
export type SearchGenerationPublicationConfig = Readonly<{
    pool: Pool;
    search: OpenSearch;
    source: SearchPublicFilterSource;
    sourceKeys: SearchPublicFilterSourceKeyPages;
    binding: SearchPublicFilterSourceBinding;
    readPublicationCompletion: SearchNativePublicationCompletionReader;
    clock: KernelClock;
    meaning: SearchPublicFilterProjectionMeaning;
    writerGuard: SearchWriterPublicationGuard;
    subjectAckProtocol?: 1;
    subjectSubscriptionProtocol?: 1;
    creditSearch?: CreditSearchSource;
    registry?: DiscoveryRegistry;
}>;
/** Preserve released projection metadata when publishing the durable activation timestamp. */
export declare function publishSubjectActivationMetadata(search: OpenSearch, index: string, activatedAt: string): Promise<void>;
/** A single native publication port for worker and CLI composition. It owns no supplied resources. */
export declare function createSearchGenerationPublication(config: SearchGenerationPublicationConfig): SearchGenerationPublication;
export {};
