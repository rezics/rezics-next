import type { PublicFilterConsumerCapture, PublicFilterConsumerCaptureInput, PublicFilterConsumerContext, PublicFilterConsumerJob, PublicFilterConsumerOperations, PublicFilterConsumerQuery, PublicFilterConsumerStatus, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
import type { QueryPrivacyDecision } from './query-privacy.ts';
/**
 * Capture, query, repair and refresh-visible acknowledgement against released owner evidence.
 * Settlement of repair is diagnostic; only a later current observation discloses. An old
 * observation with relevant changed heads stays preparing even after live pending is empty.
 *
 * Cost
 * - Touches: the existing consumer capture/query/readStatus/repairStep path. This wrapper adds
 *   no extra Source or engine work beyond those calls.
 * - Bound: the consumer's own three-round and `min(600, 6s+3)` ceilings. Repair steps remain
 *   the Source 1000-input bound. This layer loops at most the caller's deadline.
 * - Growth check: `test/search/query-privacy.test.ts` covers typed preparing, trusted stale
 *   disclosure and refused acknowledgement of an old changed observation.
 */
export type QueryPrivacyAcknowledgedQuery = Readonly<{
    status: 'queried';
    queried: PublicFilterQueriedObservation;
    execution: string;
    result: Extract<PublicFilterConsumerQuery, {
        status: 'queried';
    }>['result'];
    window: Extract<PublicFilterConsumerQuery, {
        status: 'queried';
    }>['window'];
    currentness: QueryPrivacyDecision;
    observation: Extract<PublicFilterConsumerStatus, {
        status: 'observed';
    }>;
}> | Readonly<{
    status: 'preparing';
    queried?: PublicFilterQueriedObservation;
    repair?: PublicFilterConsumerJob;
    currentness?: QueryPrivacyDecision;
}> | Readonly<{
    status: 'unavailable';
    reason: string;
}>;
export type QueryPrivacyConsumer = Readonly<{
    capture(request: Readonly<{
        plan: PublicFilterConsumerCaptureInput;
        snapshot: 'pit' | 'prepared';
    }>, context: PublicFilterConsumerContext): Promise<PublicFilterConsumerCapture>;
    query(queried: PublicFilterQueriedObservation, context: PublicFilterConsumerContext): Promise<QueryPrivacyAcknowledgedQuery>;
    repair(job: PublicFilterConsumerJob, context: PublicFilterConsumerContext): Promise<Awaited<ReturnType<PublicFilterConsumerOperations['repairStep']>>>;
    readCurrentness(request: Readonly<{
        queried: PublicFilterQueriedObservation;
        execution?: string;
    }>, context: PublicFilterConsumerContext): Promise<QueryPrivacyDecision | {
        status: 'unavailable';
        reason: string;
    }>;
}>;
export declare function createQueryPrivacyConsumer(operations: PublicFilterConsumerOperations): QueryPrivacyConsumer;
export declare function repairUntilRefreshVisible(options: {
    operations: PublicFilterConsumerOperations;
    job: PublicFilterConsumerJob;
    context: PublicFilterConsumerContext;
    queried: PublicFilterQueriedObservation;
    execution?: string;
}): Promise<QueryPrivacyDecision | {
    status: 'unavailable';
    reason: string;
} | {
    status: 'preparing';
}>;
