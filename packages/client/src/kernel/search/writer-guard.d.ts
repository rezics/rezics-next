import type { Pool } from 'pg';
import { type PublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import { type AccountDiscoveryRepairObservation } from '../access/account-discovery-source.ts';
import type { PublicFilterConsumer, PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext, PublicFilterConsumerUnavailable } from './public-filter-consumer-contract.ts';
import type { IdentityJobRef, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import { type IndexAction, type SubjectDocument } from './document.ts';
import { type OpenSearch } from './opensearch.ts';
import { type SubjectListingSource, type SubjectSource } from './source.ts';
import { type DiscoveryProjection, type DiscoveryRepairEffect } from './account-discovery.ts';
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
/** Search-visible keyed readback; absence alone never recovers an uncertain delete. */
export declare function readSearchRepairWinner(search: OpenSearch, index: string, action: IndexAction): Promise<unknown>;
/** Validate only a native record loaded by custody; this is not a settlement producer. */
export declare function validateSearchRepairWriterEvidence(index: string, receipt: SearchRepairWriterReceipt): void;
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
export declare const SEARCH_IDENTITY_WRITER_CHUNK = 100;
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
export type SearchWriterNativeCustody = SearchWriterGuard & Readonly<{
    /** Retained native repair, using the ordinary Source, serializer and writer enrollment. */
    repair(subject: string, obligation: bigint, locator: string, context: PublicFilterConsumerContext): Promise<SearchRepairWriterReceipt>;
    /** No caller body/version or saved positive can be submitted. */
    write(partition: number, ids: readonly string[], obligation: bigint): Promise<void>;
    fenceOriginal(job: IdentityJobRef, original: string): Promise<SearchIdentityWriterFence>;
    /** Closes first absence under the same native gate as enrollment; does not assert population. */
    closeGeneration(partition: number): Promise<SearchWriterBarrier>;
    /** Publication consumes retained state, never fields from a diagnostic read or caller certificate. */
    adoptGenerationPublicationBarrier(locator: SearchWriterBarrierLocator): Promise<SearchWriterBarrier>;
    readRetainedCopies(locator: SearchWriterBarrierLocator, after: string | null): Promise<Readonly<{
        copies: readonly SearchRetainedCopy[];
        next: string | null;
    }>>;
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
        cost: PublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    drainPublication(fence: SearchWriterPublicationFence, context: PublicFilterConsumerContext): Promise<{
        status: 'draining' | 'drained';
        fence: SearchWriterPublicationFence;
        cost: PublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    adoptPublication(fence: SearchWriterPublicationFence, context: PublicFilterConsumerContext): Promise<{
        status: 'held';
        fence: SearchWriterPublicationFence;
        cost: PublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
    releasePublication(fence: SearchWriterPublicationFence, context: PublicFilterConsumerContext): Promise<{
        status: 'released';
        cost: PublicFilterCost;
    } | PublicFilterConsumerUnavailable>;
}>;
export declare function bindSearchWriterPublicationSource(guard: SearchWriterPublicationGuard, binding: PublicFilterSourceBinding): void;
/** Read current native projection bodies with the external versions actually settled by this writer.
 * A later writer-custody command advances the home head without changing those external versions.
 * Missing/uncertain custody returns null and cannot certify a generation.
 */
export declare function readSearchWriterGenerationActions(guard: SearchWriterGuard, partition: number, ids: readonly string[], obligation: bigint): Promise<readonly IndexAction<SubjectDocument>[] | null>;
/** Ordinary writer custody, independent of the fixed participant and privacy-reduction continuation.
 * A submitted request with uncertain outcome retains its enrollment indefinitely until native reconciliation.
 * Time, retries, a refreshed 409 or a later physical UUID cannot release that request.
 */
export declare function createSearchWriterGuard(options: {
    pool: Pool;
    search: OpenSearch;
    index: string;
    calendarFormat?: 1;
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
