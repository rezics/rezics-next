import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { PublicFilterConsumer } from '../semantic/index.ts';
import type { SearchNativePublicationCompletionReader, SearchPublicFilterCost, SearchPublicFilterProjectionMeaning, SearchPublicFilterSource, SearchPublicFilterSourceBinding, SearchPublicFilterSourceKeyPages } from './semantic-source-port.ts';
import type { PublicFilterConsumerContext, PublicFilterConsumerUnavailable } from './public-filter-consumer-contract.ts';
import type { SearchWriterPublicationGuard } from './writer-guard.ts';
import type { DiscoveryRegistry } from './discovery.ts';
import { type OpenSearch } from './opensearch.ts';
export type GenerationPublicationJob = Readonly<{
    consumer: PublicFilterConsumer;
    job: string;
}>;
export type SearchGenerationPublication = Readonly<{
    prepare(consumer: PublicFilterConsumer, context: PublicFilterConsumerContext): Promise<{
        status: 'preparing';
        job: GenerationPublicationJob;
        cost: SearchPublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    step(job: GenerationPublicationJob, context: PublicFilterConsumerContext): Promise<{
        status: 'progress' | 'reconciled';
        job: GenerationPublicationJob;
        cost: SearchPublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    activate(job: GenerationPublicationJob, context: PublicFilterConsumerContext): Promise<{
        status: 'activated';
        consumer: PublicFilterConsumer;
        cost: SearchPublicFilterCost;
    } | {
        status: 'preparing';
        job: GenerationPublicationJob;
        cost: SearchPublicFilterCost;
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
    registry?: DiscoveryRegistry;
}>;
/** Preserve released projection metadata when publishing the durable activation timestamp. */
export declare function publishSubjectActivationMetadata(search: OpenSearch, index: string, activatedAt: string): Promise<void>;
/** A single native publication port for worker and CLI composition. It owns no supplied resources. */
export declare function createSearchGenerationPublication(config: SearchGenerationPublicationConfig): SearchGenerationPublication;
