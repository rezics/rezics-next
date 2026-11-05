import type { PublicFilterConsumerCapture, PublicFilterConsumerContext, PublicFilterConsumerOperationsFactory, PublicFilterConsumerQuery, PublicFilterConsumerRefill, PublicFilterConsumerStatus, PublicFilterQueriedObservation, PublicSuggestionCaptureInput, PublicSuggestionQuery } from './public-filter-consumer-contract.ts';
export type { PublicSuggestionCaptureInput, PublicSuggestionQuery } from './public-filter-consumer-contract.ts';
export interface PublicSuggestionOperations {
    capture(request: PublicSuggestionCaptureInput, context: PublicFilterConsumerContext): Promise<PublicFilterConsumerCapture>;
    query(queried: PublicFilterQueriedObservation, context: PublicFilterConsumerContext): Promise<PublicSuggestionQuery>;
    /** Scoped callers use the shared retained-window iterator; the public Global path keeps its original query. */
    queryScoped(queried: PublicFilterQueriedObservation, context: PublicFilterConsumerContext, refill?: PublicFilterConsumerRefill): Promise<PublicFilterConsumerQuery>;
    readStatus(request: Readonly<{
        queried: PublicFilterQueriedObservation;
        execution?: string;
    }>, context: PublicFilterConsumerContext): Promise<PublicFilterConsumerStatus>;
    closeObservation(queried: PublicFilterQueriedObservation, context: PublicFilterConsumerContext): Promise<void>;
    close(): Promise<void>;
}
/** Prefix uses the ordinary capture registry, native Source binding and execution custody.
 * The factory cannot turn an absent binding into an empty successful suggestion response.
 */
export declare function createPublicSuggestionOperations(config: Parameters<PublicFilterConsumerOperationsFactory>[0]): Promise<PublicSuggestionOperations>;
