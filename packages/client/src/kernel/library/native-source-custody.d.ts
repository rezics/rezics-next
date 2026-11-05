import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './collection-source.ts';
import type { NativePublicOutputIdentity } from './native-source-output-types.ts';
export type { NativeOutputActivation, NativePublicOutputIdentity } from './native-source-output-types.ts';
/** Lookup hints only. Native records, not possession of this value, establish custody. */
type AccountSourceIdentity = Readonly<{
    route: number;
    collectionId: string;
    accountId: string;
    incarnation: string;
    generation: string;
    ownerEpoch: number;
    receivingEpoch: string;
    effectKey: string;
} & ({
    scope: 'curated' | 'private_builtin';
    outputGeneration?: never;
    publicationTransactionId?: never;
    publicationPosition?: never;
} | {
    scope: 'active_explicit_output';
    outputGeneration: string;
    publicationTransactionId: string;
    publicationPosition: string;
})>;
export type NativeSourceIdentity = AccountSourceIdentity | NativePublicOutputIdentity;
export type NativeSourceDriver = 'member' | 'entry' | 'entry_deleted' | 'label' | 'assignment' | 'session' | 'unit' | 'change' | 'copy' | 'output' | 'done';
export type NativeSourceFrontier = Readonly<{
    captureId: string;
    driver: NativeSourceDriver;
    after: string;
    tie: string;
    sessionId: string | null;
    scanned: string;
    version: number;
}>;
declare const captureEvidence: unique symbol;
export type NativeSourceCapture = Readonly<{
    [captureEvidence]: true;
    identity: NativeSourceIdentity;
    captureId: string;
    transactionId: string;
    position: string;
    scanned: string;
}>;
declare const custodyEvidence: unique symbol;
export type NativeSourceCustody = Readonly<{
    [custodyEvidence]: true;
    identity: NativeSourceIdentity;
    captureId: string;
    holdId: string;
    transactionId: string;
}>;
export type NativeSourceCaptureWork = Readonly<{
    allowance: WorkAllowance;
    deadline: number;
}>;
/** Exact current owner episode, independently reread under native locks. Never an allow flag. */
export type NativeSourceRetirement = Readonly<{
    sourceGeneration: string;
    episode: {
        kind: 'deleted';
        deletionId: string;
        revision: number;
        purgeAfter: string;
    } | {
        kind: 'terminal';
    };
}>;
export type NativeSourceRetirementResult = Unavailable | {
    status: 'blocked';
    reason: 'live_hold' | 'release_uncommitted' | 'source' | 'public_custody';
    work: WorkReceipt;
} | {
    status: 'retired' | 'progress';
    removed: number;
    work: WorkReceipt;
};
export type NativeSourceDependency = Readonly<{
    driver: NativeSourceDriver;
    key: string;
    tie: string;
    subjectId: string | null;
    transactionId: string | null;
}>;
type Unavailable = {
    status: 'unavailable';
    reason: 'binding' | 'writer' | 'allowance' | 'output_authority';
    work: WorkReceipt;
};
export interface NativeLibrarySourceCustody {
    retireCapture(input: NativeSourceCaptureWork & NativeSourceRetirement & {
        client: CommandTransaction;
        at: AuthoritativeTime;
        identity: NativeSourceIdentity;
        captureId: string;
    }): Promise<NativeSourceRetirementResult>;
    capturePage(input: NativeSourceCaptureWork & {
        identity: NativeSourceIdentity;
        frontier: NativeSourceFrontier | null;
        limit: number;
    }): Promise<Unavailable | {
        status: 'pending';
        frontier: NativeSourceFrontier;
        rows: readonly NativeSourceDependency[];
        work: WorkReceipt;
    }>;
    finishCapture(input: NativeSourceCaptureWork & {
        identity: NativeSourceIdentity;
        frontier: NativeSourceFrontier;
    }): Promise<Unavailable | {
        status: 'complete';
        capture: NativeSourceCapture & Readonly<{
            identity: AccountSourceIdentity;
        }>;
        work: WorkReceipt;
    }>;
    /** Same live native command or admitted operational client and T; never a foreign checkout/callback. */
    readAndHold(input: NativeSourceCaptureWork & {
        client: CommandTransaction;
        at: AuthoritativeTime;
        identity: NativeSourceIdentity;
        captureId: string;
        holdId: string;
    }): Promise<Unavailable | {
        status: 'held';
        custody: NativeSourceCustody;
        work: WorkReceipt;
    }>;
    /** Existing committed custody only; never a fresh read or a new hold. Same live command client and T. */
    revalidateHold: NativeLibrarySourceCustody['readAndHold'];
    releaseHold(input: NativeSourceCaptureWork & {
        client: CommandTransaction;
        at: AuthoritativeTime;
        identity: NativeSourceIdentity;
        captureId: string;
        holdId: string;
    }): Promise<Unavailable | {
        status: 'released';
        work: WorkReceipt;
    }>;
}
/** Structural native bind validation only; this grants no Source or original authority. */
export declare function validateNativeIdentitySource(identity: NativeSourceIdentity): void;
/** Literal reached capture/basis declarations; no table-prefix or arbitrary observer callback. */
export declare function nativeSourceCustodyFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
export { declareNativeIdentitySourceBasisStatements } from './identity-native-planner-selected-pricing.ts';
/** Existing-owner raw dependency capture. No identity, canonical Source, permission or destination authority. */
export declare function createNativeLibrarySourceCustody(options: {
    pool: Pool;
    clock?: KernelClock;
}): NativeLibrarySourceCustody;
export declare function createNativeLibrarySourceCustodyWithWork(pool: Pool, work: NativeCollectionWork): NativeLibrarySourceCustody;
/** Fixed local cleanup budget; composed discovery and retirement share one receipt and command deadline. */
export declare function retireNativeCollectionCapturePage(client: CommandTransaction, input: {
    accountId: string;
    collectionId: string;
    captureId?: string;
    episode: NativeSourceRetirement['episode'];
}): Promise<NativeSourceRetirementResult>;
/** A maintenance observation of the real retained raw capture. Does not consult ready-reader Scope state.
 * The caller holds the Source-local Core transaction; all owner/capture locks remain on that client.
 */
export declare function readNativeIdentitySourceBasis(tx: CommandTransaction, identity: NativeSourceIdentity, input: NativeSourceCaptureWork & {
    captureId?: string;
}, sharedWork?: NativeCollectionWork): Promise<Unavailable | {
    status: 'current';
    frontier: NativeSourceFrontier;
    complete: boolean;
    collectionFence: string;
    accountFence: string;
    work: WorkReceipt;
}>;
