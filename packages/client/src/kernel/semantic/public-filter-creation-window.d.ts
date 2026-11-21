import type { PoolClient } from 'pg';
type CreationReader = Pick<PoolClient, 'query'>;
/** A finite original outbox interval. This is retained inside the existing
 * immutable Source repair-step state, never supplied by a public caller.
 */
export type PublicFilterCreationWindow = Readonly<{
    partition: number;
    epoch: number;
    receipt: string;
    heldBirth?: string;
    base: bigint;
    through: bigint;
    position: bigint;
    sequence: number;
    eventCount: number | null;
}>;
/** The baseline receipt and its still-retained pin are resolved by native keys.
 * Capturing through does not extend the original baseline or any served cut.
 */
export declare function readPublicFilterCreationWindow(pool: CreationReader, input: Readonly<{
    bootstrap: string;
    partition: number;
    heldBirth?: string | undefined;
}>, context: Readonly<{
    deadline: number;
}>, retained?: PublicFilterCreationWindow): Promise<PublicFilterCreationWindow>;
/** One exact (home, position, event_seq) point. Every event, including unrelated
 * events, advances the retained frontier. A pruned position or partial event
 * group is unknown; LIMIT/empty output cannot establish exhaustion.
 */
export declare function readPublicFilterCreationEvent(pool: CreationReader, input: Readonly<{
    bootstrap: string;
    window: PublicFilterCreationWindow;
}>, context: Readonly<{
    deadline: number;
}>): Promise<Readonly<{
    event: Readonly<{
        type: string;
        subject: string | null;
    }> | null;
    next: PublicFilterCreationWindow;
}>>;
export declare function publicFilterCreationAction(type: string, accounts: boolean): 'semantic' | 'accounts' | null;
type CreationEnvelope = Readonly<{
    position: string;
    event_seq: number;
    event_count: number;
    epoch: number;
    id: string;
    type: string;
    subject: string | null;
    data_digest?: string;
    transaction_id?: string | null;
}>;
type Meter = {
    inputKeys: number;
    rows: number;
    dependencyPoints: number;
};
/** Walk exact original event keys in one snapshot. A Subject range stops before
 * the first different repair identity, including that lookahead in the meter.
 * Legacy replay remains capped at its original retained count.
 */
export declare function readPublicFilterCreationEvents(pool: CreationReader, input: Readonly<{
    bootstrap: string;
    window: PublicFilterCreationWindow;
    accounts: boolean;
    inputLimit: number;
    subjectRange: boolean;
    retainedCount?: number;
}>, context: Readonly<{
    deadline: number;
}>, cost: Meter): Promise<{
    event: CreationEnvelope;
    next: PublicFilterCreationWindow;
    envelopes: readonly CreationEnvelope[];
    packed: string | undefined;
}>;
/** Read every slot of small single-event command groups inside the caller's
 * held-page snapshot. A gap, extra slot, minimized payload or relevant event
 * leaves that entire home to the ordinary creation bridge. */
export declare function readHeldQuietCommands(db: CreationReader, homes: readonly Readonly<{
    partition: number;
    epoch: number;
    base: string;
    head: string;
}>[], eventLimit: number, meter?: Meter): Promise<Map<number, string[]>>;
export {};
