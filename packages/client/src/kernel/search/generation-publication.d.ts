import type { PublicFilterCost, PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext, PublicFilterConsumerOperationsFactory, PublicFilterConsumerUnavailable } from './public-filter-consumer-contract.ts';
import type { SubjectApplyGuard } from './indexer.ts';
export type SearchGenerationPublicationLocator = Readonly<{
    publication: string;
}>;
/** Closed owner port. Only the producer can supply reconciled publication and its apply admission hook.
 * Locator/state/diagnostic counts supplied by a consumer never authorize activation.
 */
export interface SearchGenerationPublication {
    prepare(request: Readonly<{
        generation: number;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'prepared';
        locator: SearchGenerationPublicationLocator;
        writer: SubjectApplyGuard;
        cost: PublicFilterCost;
    }> | PublicFilterConsumerUnavailable>;
    step(locator: SearchGenerationPublicationLocator, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'progress' | 'reconciled';
        cost: PublicFilterCost;
    }> | PublicFilterConsumerUnavailable>;
    activate(locator: SearchGenerationPublicationLocator, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'active';
        generation: number;
        previous: number | null;
        cost: PublicFilterCost;
    }> | PublicFilterConsumerUnavailable>;
    close(): Promise<void>;
}
export type SearchGenerationPublicationConfig = Omit<Parameters<PublicFilterConsumerOperationsFactory>[0], 'context' | 'physicalTarget' | 'meaning' | 'source'> & Readonly<{
    prefix: string;
    source: PublicFilterSource;
}>;
/** PROVISIONAL producer adapter, selected while the publication module is absent.
 * Replace with the publication owner's actual implementation on integration, preserving this handoff.
 * No reconciliation, alias write, ordinary-writer guard or native completion is implemented here.
 */
export declare function createSearchGenerationPublication(_config: SearchGenerationPublicationConfig): SearchGenerationPublication;
