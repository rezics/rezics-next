import type { CommandTransaction } from '../command/command.ts';
import type { IdentityFrontier, IdentityJobRef, IdentityNativeReceipt, NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import type { NativeIdentityReceivingBinding, NativeIdentityReceivingRecord } from '../semantic/identity-receiving-effects-types.ts';
import type { SearchWriterBarrierLocator } from './writer-guard.ts';
/** An operational locator. Resolving it must read committed native custody. */
export type SearchIdentityReceivingLocator = Readonly<{
    kind: 'search-canonical-index';
    version: 1;
    partition: number;
    planId: string;
}>;
export type SearchIdentityReceivingSelection = Readonly<{
    job: IdentityJobRef;
    original: string;
    effectKey: string;
    owner: string;
    sourceId: string;
    scope: string;
    disposition: 'OLD' | 'NEW' | 'first-apply' | 'handoff';
    native: SearchIdentityReceivingLocator;
}>;
/** Search-owned source identity; no Library capture or account custody is interchangeable. */
export type SearchIdentityReceivingSource = Readonly<{
    locator: SearchIdentityReceivingLocator;
    original: string;
    terminal: string;
    documentId: string;
    owner: string;
    sourceId: string;
    scope: string;
    disposition: SearchIdentityReceivingSelection['disposition'];
    receivingHome: number;
    receivingEpoch: number;
    consumer: string;
    physicalTarget: string;
    incarnation: string;
    writeAlias: string;
    physicalGeneration: number;
    enrollmentGeneration: bigint;
    fenceGeneration: bigint;
    barrier: SearchWriterBarrierLocator;
    originalFence: IdentityNativeReceipt;
    plan: IdentityNativeReceipt;
}>;
export type SearchIdentityReceivingHold = Readonly<{
    locator: SearchIdentityReceivingLocator;
    holdId: string;
    source: SearchIdentityReceivingSource;
}>;
export type SearchIdentityReceivingContext = Readonly<{
    deadline: number;
    /** Reserved from the caller's original frame; this does not mint an allowance. */
    allowance: NativeStepWork;
}>;
export type SearchIdentityReceivingResult<T> = Readonly<{
    status: 'ready';
    value: T;
    work: NativeStepWork;
}> | Readonly<{
    status: 'changed' | 'draining' | 'unavailable';
    work: NativeStepWork;
}>;
/** Library's public aliases stay Library-only. Select Search from the canonical native unions. */
export type SearchIdentityReceivingBinding = Extract<NativeIdentityReceivingBinding, {
    step: 'search-canonical-index';
}>;
export type SearchIdentityReceivingRecord = Extract<NativeIdentityReceivingRecord, {
    step: 'search-canonical-index';
}>;
export declare const SEARCH_IDENTITY_RECEIVING_FRONTIER_MAX_BYTES = 1792;
/** Snapshot scalar data before an await. JSON coercions, accessors and inherited fields cannot
 * change the frontier between its admission, native mutation and late common/step callbacks.
 */
export declare function snapshotSearchIdentityReceivingFrontier(value: unknown): IdentityFrontier | null;
/** Validate before serialization: JSON would silently turn nonfinite numbers into null. */
export declare function validSearchIdentityReceivingFrontier(value: IdentityFrontier): boolean;
/** Selected owner ABI. A declaration neither installs an adapter nor grants admission. */
export interface SearchIdentityReceivingNative {
    resolvePlanned(selection: SearchIdentityReceivingSelection, context: SearchIdentityReceivingContext): Promise<SearchIdentityReceivingResult<SearchIdentityReceivingSource>>;
    readAndHold(tx: CommandTransaction, binding: SearchIdentityReceivingBinding, context: SearchIdentityReceivingContext): Promise<SearchIdentityReceivingResult<SearchIdentityReceivingHold>>;
    revalidateHold(tx: CommandTransaction, record: SearchIdentityReceivingRecord, context: SearchIdentityReceivingContext): Promise<SearchIdentityReceivingResult<SearchIdentityReceivingHold>>;
    recordApplied(tx: CommandTransaction, record: SearchIdentityReceivingRecord, frontier: IdentityFrontier, context: SearchIdentityReceivingContext): Promise<SearchIdentityReceivingResult<Readonly<{
        holdId: string;
    }>>>;
    reconcileOriginal(locator: SearchIdentityReceivingLocator, after: string | null, context: SearchIdentityReceivingContext): Promise<SearchIdentityReceivingResult<Readonly<{
        after: string | null;
        state: 'progress' | 'settled';
    }>>>;
    releaseHold(tx: CommandTransaction, record: SearchIdentityReceivingRecord, context: SearchIdentityReceivingContext): Promise<SearchIdentityReceivingResult<Readonly<{
        holdId: string;
    }>>>;
}
