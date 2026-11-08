import type { DiscoveryConsumerQuery } from './discovery.ts';
import type { PublicCanonicalCaptureInput, PublicFilterConsumerCapture, PublicFilterConsumerContext, PublicFilterConsumerOperations, PublicFilterConsumerQuery, PublicFilterConsumerRefill, PublicFilterConsumerUnavailable, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
/** Request-local access to the SAME native consumer. This object is never serialized
 * or accepted as permission: every transition resolves the original native rows.
 */
export type PublicFilterCoveragePage = Readonly<{
    capture(plan: PublicCanonicalCaptureInput, snapshot: 'pit' | 'prepared'): Promise<PublicFilterConsumerCapture>;
    query(queried: PublicFilterQueriedObservation, refill?: PublicFilterConsumerRefill): Promise<PublicFilterConsumerQuery>;
    queryDiscovery(queried: PublicFilterQueriedObservation, refill?: PublicFilterConsumerRefill): Promise<DiscoveryConsumerQuery>;
    /** Persist the actual raw prefix consumed by owner hydration before refill or sealing. */
    consume(execution: string, consumed: number): Promise<void>;
    /** After all dependent reads, metadata and cursor construction, including empty exhaustion. */
    finish(): Promise<void>;
    /** Abandons admission; it cannot stand in for finish or certify an uncertain child. */
    dispose(): Promise<void>;
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
/** Internal role binding only. The UUID must already name a closed native plan;
 * the Source statement checks its observation, definition, owner and deadline.
 */
export declare function withPublicFilterCoverageStart<T>(context: PublicFilterConsumerContext, id: string, run: () => Promise<T>): Promise<T>;
export declare function publicFilterCoverageStart(context: PublicFilterConsumerContext): string | null;
export {};
