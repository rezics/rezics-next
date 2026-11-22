import type { DiscoveryConsumerQuery } from './discovery.ts';
import type { SourceBindingFailureReason } from '../semantic/index.ts';
import type { PublicCanonicalCaptureInput, PublicFilterConsumerCapture, PublicFilterConsumerContext, PublicFilterConsumerOperations, PublicFilterConsumerQuery, PublicFilterConsumerRefill, PublicFilterConsumerUnavailable, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
/** Fixed labels from the original capture. No consumer, key, observation or source payload is retained. */
export type PublicFilterCaptureWitness = Readonly<{
    stage: 'definition' | 'registration' | 'population-bootstrap' | 'retained-population-bootstrap' | 'published-coverage' | 'begin' | 'population-repair';
    reason?: SourceBindingFailureReason;
}> | Readonly<{
    stage: 'open-registration-observation';
    reason: 'observation_has_consumer_work' | 'observation_without_consumer_work';
}>;
/** Request-local access to the SAME native consumer. This object is never serialized
 * or accepted as permission: every transition resolves the original native rows.
 */
export type PublicFilterCoveragePage = Readonly<{
    capture(plan: PublicCanonicalCaptureInput, snapshot: 'pit' | 'prepared'): Promise<PublicFilterConsumerCapture>;
    captureWitness?(): PublicFilterCaptureWitness | undefined;
    query(queried: PublicFilterQueriedObservation, refill?: PublicFilterConsumerRefill): Promise<PublicFilterConsumerQuery>;
    queryDiscovery(queried: PublicFilterQueriedObservation, refill?: PublicFilterConsumerRefill): Promise<DiscoveryConsumerQuery>;
    /** Persist the actual raw prefix consumed by owner hydration before refill or sealing. */
    consume(execution: string, consumed: number): Promise<void>;
    /** After all dependent reads, metadata and cursor construction, including empty exhaustion. */
    finish(): Promise<void>;
    /** Abandons admission; it cannot stand in for finish or certify an uncertain child. */
    dispose(): Promise<void>;
    /** Release this finished page's reference while closing its exhausted observation. */
    closeExhausted?(): Promise<void>;
    /** Translate native refusal without treating an unknown serving error as authority. */
    failure(error: unknown): PublicFilterConsumerUnavailable;
}>;
type Opener = (context: PublicFilterConsumerContext, capture?: Extract<PublicFilterConsumerCapture, {
    status: 'captured';
}>) => PublicFilterCoveragePage;
/** Installed only by the real consumer factory, including its resource-owner wrapper. */
export declare function installPublicFilterCoveragePage(operations: PublicFilterConsumerOperations, open: Opener): void;
export declare function forwardPublicFilterCoveragePage(original: PublicFilterConsumerOperations, wrapper: PublicFilterConsumerOperations): void;
export declare function openPublicFilterCoveragePage(operations: PublicFilterConsumerOperations, context: PublicFilterConsumerContext, capture?: Extract<PublicFilterConsumerCapture, {
    status: 'captured';
}>): PublicFilterCoveragePage;
/** Each ID names an already planned native page. The Source statement resolves
 * every original binding and deadline before it retains a start for that page.
 */
export declare function withPublicFilterCoverageStarts<T>(pages: readonly Readonly<{
    context: PublicFilterConsumerContext;
    id: string;
}>[], run: () => Promise<T>): Promise<T>;
export declare function withPublicFilterCoverageStart<T>(context: PublicFilterConsumerContext, id: string, run: () => Promise<T>): Promise<T>;
export declare function publicFilterCoverageStart(context: PublicFilterConsumerContext): string | null;
export {};
