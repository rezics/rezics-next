import type { Pool } from 'pg';
import type { IdentityJobRef, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { OpenSearch } from './opensearch.ts';
import { type SubjectListingSource, type SubjectSource } from './source.ts';
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
}): SearchWriterGuard;
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
