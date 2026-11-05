import type { Pool, PoolClient } from 'pg';
import { type OperationalTransaction } from '../command/operational.ts';
import type { WorkClient, WorkIntent } from '../work/client.ts';
import { type HistoryScope } from './locator.ts';
import { type OperationalWorkOriginal, type OperationalWorkPhase, type OperationalWorkTransfer } from './operational-work-budget.ts';
export { OPERATIONAL_WORK_LOCAL_DECLARATION, OPERATIONAL_WORK_REGISTRATION, OPERATIONAL_WORK_RECEIVING, OPERATIONAL_WORK_TRANSFER_COST, type OperationalWorkTransfer, } from './operational-work-budget.ts';
export declare const OPERATIONAL_WORK_OWNER = "library.members-preparation";
export declare const OPERATIONAL_WORK_WORKFLOW = "library.membersPreparation";
/** Dispatch hint only. Every use must independently resolve the durable native mapping. */
export declare const isOperationalWorkCustodyId: (id: string) => boolean;
export type OperationalEpisode = Readonly<{
    collectionId: string;
    episodeId: string;
}>;
export type OperationalMembersBinding = Readonly<{
    route: number;
    ownerAccountId: string;
    collectionId: string;
    /** Exact NEW reservations; reuse with intent:null never enters this API. */
    episodes: readonly Readonly<OperationalEpisode & {
        reservedIncarnation: string;
        reservedGeneration: string;
        canonicalBasis: string;
        basisDigest: string;
    }>[];
    retired: readonly OperationalEpisode[];
}>;
declare const registration: unique symbol;
/** A serializable lookup key, NOT a receipt or evidence that COMMIT happened. */
export type OperationalWorkRegistration = Readonly<{
    partition: number;
    custodyId: string;
    readonly [registration]: true;
}>;
export declare function beginOperationalHistoryAttempt(tx: OperationalTransaction, original: OperationalWorkOriginal): void;
/** A private, prepaid, one-shot child transfer. It activates ONLY after this actual executor's
 * successful COMMIT. Copies, failed attempts and escaped live handles cannot issue or spend it. */
export declare function reserveOperationalWorkTransfer(tx: OperationalTransaction, phase: OperationalWorkPhase): OperationalWorkTransfer;
/** Pure shape/digest verification. It does not attest that a Commerce reservation exists. The
 * genuine Commerce writer supplies the native fields after its successful reserve SQL. */
export declare function validateOperationalMembersBinding(binding: OperationalMembersBinding, intent: WorkIntent): string;
/** Internal enqueue hook: the existing enqueueIntent still owns the sole SDK call and SAME
 * underlying pg client. No identity mapping, CommandTransaction or alternate queue is involved. */
export declare function operationalHistoryEnqueueCapture(tx: OperationalTransaction, intent: WorkIntent): ((created: boolean) => void) | undefined;
export declare const OPERATIONAL_WORK_DOMAIN = "operational-work/v1";
export type OperationalWorkDomain = typeof OPERATIONAL_WORK_DOMAIN | 'legacy-unpositioned';
/** Distinct from the canonical event Stamp. Positions compare ONLY within this domain/partition.
 * Decimal strings preserve the entire positive PostgreSQL bigint range across JSON/SDK ports. */
export type OperationalWorkStamp = Readonly<{
    domain: typeof OPERATIONAL_WORK_DOMAIN;
    partition: number;
    epoch: number;
    generation: string;
    position: string;
}>;
/** Versioned opt-in ORIGINAL serializer. Call immediately after the native reservation SQL;
 * this replaces that call site's sole enqueueIntent. The locator is not a committed receipt. */
export declare function registerPositionedOperationalHistoryWork(tx: OperationalTransaction, binding: OperationalMembersBinding, intent: WorkIntent): Promise<OperationalWorkRegistration>;
/** Retained unpositioned interface. Its originals stay explicitly legacy; neither reuse nor a
 * later call through the positioned interface backfills them or captures an old SDK execution. */
export declare function registerOperationalHistoryWork(tx: OperationalTransaction, binding: OperationalMembersBinding, intent: WorkIntent): Promise<OperationalWorkRegistration>;
/** Native exact inventory, shared by the source serializer and committed destination receiver.
 * Source identity is read from the native original, never supplied by its caller. */
export declare function insertOperationalWorkInventory(tx: Pick<PoolClient, 'query'>, partition: number, custodyId: string, digest: Uint8Array, scope: HistoryScope, intent: WorkIntent, sourcePartition: number, sourceTransaction: string | null): Promise<void>;
/** Seal before the executor's actual COMMIT. The deferred native constraint verifies the
 * positioned binding against the locked head and actual partition/family fences. */
export declare function finalizeOperationalHistoryAttempt(tx: OperationalTransaction): Promise<void>;
export declare function finishOperationalHistoryAttempt(tx: OperationalTransaction, committed: boolean): void;
export declare const OPERATIONAL_SDK_TABLES: readonly [readonly ['workflow_status', 'workflow_uuid'], readonly ['workflow_input', 'workflow_uuid'], readonly ['workflow_output', 'workflow_uuid'], readonly ['operation_outputs', 'workflow_uuid'], readonly ['workflow_events', 'workflow_uuid'], readonly ['workflow_events_history', 'workflow_uuid'], readonly ['notifications', 'destination_uuid'], readonly ['streams', 'workflow_uuid']];
type OperationalWorkSourceBody = Readonly<{
    partition: number;
    custodyId: string;
    transactionId: string;
    epoch: number;
    generation: string;
    workflowId: string;
    digest: string;
    binding: OperationalMembersBinding;
    intent: WorkIntent;
    scope: HistoryScope;
    sdkWriter: import('../work/sdk-retirement-fence.ts').SdkWriterState;
    sdkCreator: string | null;
    sdkInputDigest: string;
    creationCaptured: boolean;
    deadline: number;
}>;
export type OperationalWorkSource = OperationalWorkSourceBody & (Readonly<{
    position: null;
    gap: 'operational-work-original-log-position-unavailable';
    stamp?: never;
}> | Readonly<{
    position: string;
    gap: 'operational-work-source-currentness-unavailable';
    stamp: OperationalWorkStamp;
}>);
declare const committedOrigin: unique symbol;
export type CommittedOperationalWork = {
    readonly [committedOrigin]: true;
};
export declare function operationalWorkSource(pool: Pool, origin: CommittedOperationalWork): OperationalWorkSource;
/** A separately prepaid same-home recheck. All native source fences stay held through this
 * commit; the result is LOCAL provenance only, not a Source-currentness or replay capability.
 * Call after releasing any receiving client, never inside a cross-home callback. */
export declare function verifyCommittedOperationalWorkOrigin(pool: Pool, origin: CommittedOperationalWork, transfer: OperationalWorkTransfer): Promise<OperationalWorkStamp>;
/** One full-key committed-state resolution. Precommit/rolled-back locators return null. This
 * function requires a released, successful original transfer before any Pool checkout. */
export declare function resolveCommittedOperationalWork(pool: Pool, locator: OperationalWorkRegistration, transfer: OperationalWorkTransfer): Promise<CommittedOperationalWork | null>;
/** Release the source client before entering the independently fenced destination home. */
export declare function receiveCommittedOperationalWork(pool: Pool, client: WorkClient, origin: CommittedOperationalWork, transfer: OperationalWorkTransfer): Promise<'registered-pending-source-currentness' | 'registered-pending-position' | 'uncaptured'>;
