import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { PublicFilterConsumer, PublicFilterCost, PublicFilterProjectionMeaning, PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import type { SubjectSourceKeyPages } from '../semantic/subject-source-key-pages.ts';
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
        cost: PublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    step(job: GenerationPublicationJob, context: PublicFilterConsumerContext): Promise<{
        status: 'progress' | 'reconciled';
        job: GenerationPublicationJob;
        cost: PublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    activate(job: GenerationPublicationJob, context: PublicFilterConsumerContext): Promise<{
        status: 'activated';
        consumer: PublicFilterConsumer;
        cost: PublicFilterCost;
    } | {
        status: 'preparing';
        job: GenerationPublicationJob;
        cost: PublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    close(): Promise<void>;
}>;
export type SearchGenerationPublicationConfig = Readonly<{
    pool: Pool;
    search: OpenSearch;
    source: PublicFilterSource;
    sourceKeys: SubjectSourceKeyPages;
    binding: PublicFilterSourceBinding;
    clock: KernelClock;
    meaning: PublicFilterProjectionMeaning;
    writerGuard: SearchWriterPublicationGuard;
    registry?: DiscoveryRegistry;
}>;
/** A single native publication port for worker and CLI composition. It owns no supplied resources. */
export declare function createSearchGenerationPublication(config: SearchGenerationPublicationConfig): SearchGenerationPublication;
