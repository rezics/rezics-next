import type { Pool } from 'pg';
import type { AccountDiscoveryRepairObservation } from '../access/account-discovery-source.ts';
import type { PublicFilterConsumer } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext, PublicFilterConsumerUnavailable } from './public-filter-consumer-contract.ts';
import { type CommandTransaction } from '../command/command.ts';
import type { StoredSource } from './identity-receiving-native-internal.ts';
import type { IdentityJobRef, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import { type IndexAction, type SubjectDocument } from './document.ts';
import { type OpenSearch } from './opensearch.ts';
import { type SubjectListingSource, type SubjectSource } from './source.ts';
import { type DiscoveryProjection, type DiscoveryRepairEffect } from './account-discovery.ts';
import type { SearchNativePublicationCompletionReader, SearchPublicFilterCost } from './semantic-source-port.ts';
/** Durable native evidence retained by the existing writer, never supplied by Source callers. */
export type SearchRepairWriterReceipt = Readonly<{
    locator: string;
    subject: string;
    partition: number;
    epoch: number;
    incarnation: string;
    writeAlias: string;
    consumer: string;
    action: IndexAction;
    enrollment: IdentityNativeReceipt;
    completion: IdentityNativeReceipt;
    native: unknown;
}>;
/** The mixed writer retains its actual tagged actions and both allocation identities. */
export type DiscoveryRepairWriterReceipt = Readonly<{
    writer: 'discovery';
    /** Absent on retained Subject receipts written before owner separation. */
    owner?: 'semantic' | 'accounts';
    account?: AccountDiscoveryRepairObservation;
    locator: string;
    subject: string;
    partition: number;
    epoch: number;
    incarnation: string;
    allocation: string;
    writeAlias: string;
    consumer: string;
    sourcePosition: bigint;
    effects: readonly DiscoveryRepairEffect[];
    enrollment: IdentityNativeReceipt;
    completion: IdentityNativeReceipt;
}>;
export type PublicFilterRepairWriterReceipt = SearchRepairWriterReceipt | DiscoveryRepairWriterReceipt;
export declare function isDiscoveryRepairWriterReceipt(receipt: PublicFilterRepairWriterReceipt): receipt is DiscoveryRepairWriterReceipt;
export declare const repairWriterPosition: (receipt: PublicFilterRepairWriterReceipt) => bigint;
export declare const decodeSearchRepairWriterReceipt: (value: string) => SearchRepairWriterReceipt;
export declare function decodeSearchIdentityWriterAction(value: string, source: StoredSource): IndexAction;
/** Search-visible keyed readback; absence alone never recovers an uncertain delete. */
export declare function readSearchRepairWinner(search: OpenSearch, index: string, action: IndexAction): Promise<unknown>;
/** Validate only a native record loaded by custody; this is not a settlement producer. */
export declare function validateSearchRepairWriterEvidence(index: string, receipt: SearchRepairWriterReceipt, { allowReadbackRecovery }?: {
    allowReadbackRecovery?: boolean;
}): void;
/** Recheck retained evidence and lock the actual existing writer through the reader boundary. */
export declare function verifySearchRepairWriterReceipt(db: Pick<Pool, 'query'>, search: OpenSearch, index: string, receipt: SearchRepairWriterReceipt): Promise<void>;
/** Dispatch by original physical family; no mixed receipt is accepted by the Subject verifier. */
export declare function validatePublicFilterRepairWriterEvidence(index: string, receipt: PublicFilterRepairWriterReceipt): void;
export declare function readPublicFilterRepairPhysicalTarget(db: Pick<Pool, 'query'>, search: OpenSearch, index: string): Promise<Readonly<{
    incarnation: string;
    writeAlias: string;
}>>;
export declare function verifyPublicFilterRepairWriterReceipt(db: Pick<Pool, 'query'>, search: OpenSearch, index: string, receipt: PublicFilterRepairWriterReceipt): Promise<void>;
/** Uses the existing native writer enrollment, dispatch and settlement rows, with the actual
 * mixed projection as the only body/version producer. An interrupted attempt replays its retained actions;
 * no copy flag, current ACK or engine conflict is a repair receipt.
 */
export declare function createDiscoveryRepairWriter(options: {
    pool: Pool;
    search: OpenSearch;
    consumer: string;
    projection: DiscoveryProjection;
}): {
    repair(subject: string, obligation: bigint, locator: string, context: PublicFilterConsumerContext): Promise<Readonly<{
        writer: 'discovery';
        /** Absent on retained Subject receipts written before owner separation. */
        owner?: 'semantic' | 'accounts';
        account?: AccountDiscoveryRepairObservation;
        locator: string;
        subject: string;
        partition: number;
        epoch: number;
        incarnation: string;
        allocation: string;
        writeAlias: string;
        consumer: string;
        sourcePosition: bigint;
        effects: readonly DiscoveryRepairEffect[];
        enrollment: IdentityNativeReceipt;
        completion: IdentityNativeReceipt;
    }>>;
    repairAccount(account: string, locator: string, context: PublicFilterConsumerContext): Promise<Readonly<{
        writer: 'discovery';
        /** Absent on retained Subject receipts written before owner separation. */
        owner?: 'semantic' | 'accounts';
        account?: AccountDiscoveryRepairObservation;
        locator: string;
        subject: string;
        partition: number;
        epoch: number;
        incarnation: string;
        allocation: string;
        writeAlias: string;
        consumer: string;
        sourcePosition: bigint;
        effects: readonly DiscoveryRepairEffect[];
        enrollment: IdentityNativeReceipt;
        completion: IdentityNativeReceipt;
    }>>;
};
export { SEARCH_IDENTITY_WRITER_CHUNK } from './writer-limits.ts';
/** A locator only. All adoption reads retained native rows under the current home owner. */
export type SearchWriterBarrierLocator = Readonly<{
    partition: number;
    token: string;
}>;
export type SearchWriterBarrier = Readonly<{
    locator: SearchWriterBarrierLocator;
    consumer: string;
    physicalTarget: string;
    writeAlias: string;
    incarnation: string;
    physicalGeneration: number;
    enrollmentGeneration: bigint;
    fenceGeneration: bigint;
    native: IdentityNativeReceipt;
    ordinary: 'draining' | 'drained';
    /** The delivered receiving binding only accepts Library. No Search first-apply proof exists yet. */
    firstApply: 'unavailable';
    prepared: 'unavailable';
}>;
export type SearchRetainedCopy = Readonly<{
    original: string;
    sourcePosition: bigint | null;
    visible: IdentityNativeReceipt | null;
    enrollment: IdentityNativeReceipt | null;
    state: 'enrolled' | 'dispatched' | 'settled' | 'cancelled';
}>;
export type SearchWriterGuard = Readonly<{
    write(partition: number, ids: readonly string[], obligation: bigint): Promise<void>;
}>;
export type SearchIdentityWriterAdmission = Readonly<{
    incarnation: string;
    writeAlias: string;
    enrollmentGeneration: bigint;
    fenceGeneration: bigint;
    close: string | null;
}>;
export type SearchWriterNativeCustody = SearchWriterGuard & Readonly<{
    /** Retained native repair, using the ordinary Source, serializer and writer enrollment. */
    repair(subject: string, obligation: bigint, locator: string, context: PublicFilterConsumerContext): Promise<SearchRepairWriterReceipt>;
    /** No caller body/version or saved positive can be submitted. */
    write(partition: number, ids: readonly string[], obligation: bigint): Promise<void>;
    fenceOriginal(job: IdentityJobRef, original: string): Promise<SearchIdentityWriterFence>;
    observeIdentityPreparation(tx: CommandTransaction, job: IdentityJobRef, original: string, allocation: Readonly<{
        incarnation: string;
        writeAlias: string;
    }>): Promise<Readonly<{
        enrollmentGeneration: string;
        fenceGeneration: string;
        close: string | null;
    }>>;
    prepareIdentityAction(tx: CommandTransaction, job: IdentityJobRef, original: string, planId: string, admission: SearchIdentityWriterAdmission, document?: SubjectDocument): Promise<Readonly<{
        close: IdentityNativeReceipt;
        physicalGeneration: number;
        enrollmentGeneration: bigint;
        fenceGeneration: bigint;
        actionDigest: string;
        previousPlan: string | null;
        firstAbsence: boolean;
        previousVisible: IdentityNativeReceipt | null;
    }>>;
    dispatchIdentityAction(tx: CommandTransaction, job: IdentityJobRef, source: StoredSource, token: string): Promise<IdentityNativeReceipt>;
    settleIdentityAction(tx: CommandTransaction, job: IdentityJobRef, source: StoredSource, token: string, dispatch: IdentityNativeReceipt, action: IndexAction, bulk: unknown): Promise<number>;
    /** Closes first absence under the same native gate as enrollment; does not assert population. */
    closeGeneration(partition: number): Promise<SearchWriterBarrier>;
    /** Publication consumes retained state, never fields from a diagnostic read or caller certificate. */
    adoptGenerationPublicationBarrier(locator: SearchWriterBarrierLocator): Promise<SearchWriterBarrier>;
    readRetainedCopies(locator: SearchWriterBarrierLocator, after: string | null): Promise<Readonly<{
        copies: readonly SearchRetainedCopy[];
        next: string | null;
    }>>;
    /** Reads the copy for exactly one original in the retained generation barrier. */
    readRetainedCopy(locator: SearchWriterBarrierLocator, original: string, deadline: number): Promise<SearchRetainedCopy | null>;
    /** Revokes at most 100 undispatched enrollments. Dispatched uncertainty remains a drain barrier. */
    recoverInterrupted(locator: SearchWriterBarrierLocator, after: string | null): Promise<Readonly<{
        examined: number;
        revoked: number;
        uncertain: number;
        next: string | null;
    }>>;
}>;
export type SearchWriterPublicationFence = Readonly<{
    consumer: PublicFilterConsumer;
    job: string;
    fence: string;
}>;
export type SearchWriterPublicationGuard = SearchWriterGuard & Readonly<{
    fencePublication(request: Readonly<{
        consumer: PublicFilterConsumer;
        job: string;
    }>, context: PublicFilterConsumerContext): Promise<{
        status: 'fenced';
        fence: SearchWriterPublicationFence;
        cost: SearchPublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    drainPublication(fence: SearchWriterPublicationFence, context: PublicFilterConsumerContext): Promise<{
        status: 'draining' | 'drained';
        fence: SearchWriterPublicationFence;
        cost: SearchPublicFilterCost;
        advanced?: boolean;
    } | PublicFilterConsumerUnavailable>;
    adoptPublication(fence: SearchWriterPublicationFence, context: PublicFilterConsumerContext): Promise<{
        status: 'held';
        fence: SearchWriterPublicationFence;
        cost: SearchPublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    releasePublication(fence: SearchWriterPublicationFence, context: PublicFilterConsumerContext): Promise<{
        status: 'released';
        cost: SearchPublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
}>;
export declare function bindSearchWriterPublicationReader(guard: SearchWriterPublicationGuard, reader: SearchNativePublicationCompletionReader): void;
/** Read current native projection bodies with the external versions actually settled by this writer.
 * A later writer-custody command advances the home head without changing those external versions.
 * Missing/uncertain custody returns null and cannot certify a generation.
 */
export declare function readSearchWriterGenerationActions(guard: SearchWriterGuard, partition: number, ids: readonly string[], obligation: bigint): Promise<readonly IndexAction<SubjectDocument>[] | null>;
export declare const readRetainedWriterCopySql = "SELECT g.incarnation AS gate_incarnation,g.owner_epoch AS gate_epoch,\n  w.original_id::text,w.source_position,w.visible_transaction_id,w.visible_position,\n  w.writer_transaction_id,w.writer_position,w.writer_token,w.dispatch_state,w.owner_epoch,w.incarnation\n FROM core.partition p\n JOIN search.identity_writer_gate g ON g.partition_no=p.partition_no AND g.physical_target=$2\n LEFT JOIN search.identity_writer w ON (w.partition_no,w.physical_target,w.original_id)=(g.partition_no,g.physical_target,$5)\n WHERE p.partition_no=$1 AND p.write_state='active' AND p.epoch=g.owner_epoch AND p.position>=g.closed_position\n  AND g.closed_token=$3 AND g.consumer=$4";
export declare function searchIdentityWriterSettlementSql(): "/* search:identity-writer:settle */\nWITH input AS (\n  SELECT $1::integer AS partition_no, $2::text AS physical_target, $3::text AS incarnation,\n    $4::integer AS owner_epoch, $5::uuid AS writer_token, $6::uuid AS writer_transaction_id,\n    $7::bigint AS writer_position, $8::uuid[] AS ids,\n    $9::uuid AS settled_transaction_id, $10::bigint AS settled_position, $11::bigint AS source_position\n)\nUPDATE search.identity_writer AS writer SET writer_token=NULL,\n  settled_transaction_id=input.settled_transaction_id, settled_position=input.settled_position,\n  visible_transaction_id=CASE WHEN input.source_position IS NULL THEN writer.visible_transaction_id ELSE input.settled_transaction_id END,\n  visible_position=CASE WHEN input.source_position IS NULL THEN writer.visible_position ELSE input.settled_position END,\n  source_position=COALESCE(input.source_position,writer.source_position),\n  dispatch_state=CASE WHEN input.source_position IS NULL THEN 'cancelled' ELSE 'settled' END\nFROM input\nWHERE writer.partition_no=input.partition_no AND writer.physical_target=input.physical_target\n  AND writer.incarnation=input.incarnation AND writer.owner_epoch=input.owner_epoch\n  AND writer.writer_token=input.writer_token AND writer.writer_transaction_id=input.writer_transaction_id\n  AND writer.writer_position=input.writer_position AND writer.original_id=ANY(input.ids)\n  AND ((input.source_position IS NULL AND writer.dispatch_state='enrolled')\n    OR (input.source_position IS NOT NULL AND writer.dispatch_state='dispatched'))\nRETURNING writer.original_id;";
export declare function searchIdentityWriterAdmissionSql(): {
    gate: "/* search:writer-guard:gate */\nSELECT enrollment_generation, fence_generation, closed_token\nFROM search.identity_writer_gate\nWHERE partition_no=$1 AND physical_target=$2 AND consumer=$3\n  AND incarnation=$4 AND owner_epoch=$5 AND write_alias=$6\nFOR UPDATE;";
    insertGate: string;
    original: string;
};
/** Ordinary writer custody, independent of the fixed participant and privacy-reduction continuation.
 * A submitted request with uncertain outcome retains its enrollment indefinitely until native reconciliation.
 * Time, retries, a refreshed 409 or a later physical UUID cannot release that request.
 */
export declare function createSearchWriterGuard(options: {
    pool: Pool;
    search: OpenSearch;
    index: string;
    consumer: string;
    source: SubjectSource;
    listing: SubjectListingSource;
}): SearchWriterNativeCustody & SearchWriterPublicationGuard;
export type SearchIdentityWriterFence = Readonly<{
    state: 'draining' | 'closed';
    gate: IdentityNativeReceipt;
    writer: IdentityNativeReceipt | null;
    settlement: IdentityNativeReceipt | null;
    sourcePosition: bigint | null;
}>;
/** Install the real home-local structural close, including first absence, and observe in-flight custody.
 * This is a local operational record, NEVER a fixed participant completion or a complete-support proof.
 * There is deliberately no timeout, force-release, caller completion flag or reopen method.
 */
export declare function fenceSearchIdentityWriter(pool: Pool, options: Readonly<{
    job: IdentityJobRef;
    original: string;
    index: string;
    search: OpenSearch;
}>): Promise<SearchIdentityWriterFence>;
export declare const unavailableSearchWriterPublication: Omit<SearchWriterPublicationGuard, 'write'>;
