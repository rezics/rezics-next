import type { PoolClient } from 'pg';
import { type OperationalTransaction } from '../command/operational.ts';
import type { LibraryProfilePin } from './profile.ts';
type Client = Pick<PoolClient, 'query'>;
export type OwnerIndexPhase = 'entry' | 'session' | 'copy' | 'label' | 'ready';
export type OwnerIndexFrontier = Readonly<{
    phase: OwnerIndexPhase;
    subject: string | null;
    fact: string | null;
}>;
/** Pure native reads: absent control is unbuilt, never an empty/ready owner. */
export declare function readOwnerIndexFrontier(client: Client, accountId: string): Promise<OwnerIndexFrontier | null>;
/** At most 100 examined native facts. The caller supplies the real fenced Core operational transaction. */
export declare function stepOwnerIndex(tx: OperationalTransaction, accountId: string): Promise<OwnerIndexFrontier>;
/** One structural ORIGINAL seek; this is not canonical membership, disclosure or a useful public page. */
export declare function readOwnerOriginalPrefix(client: Client, accountId: string, after: string | null, limit: number): Promise<string[]>;
/** Native independent supports. Label parent liveness is checked even if directory cleanup is delayed. */
export declare function readOwnerOriginalTruth(client: Client, accountId: string, original: string): Promise<{
    original: string;
    presence: boolean | null;
    families: {
        entry: boolean;
        label: boolean | null;
        session: boolean;
        copy: boolean;
    };
    state: {
        id: string;
        sequence: bigint | null;
        pin: import("@rezics/definitions").LibraryProfilePin | null;
    } | null;
}>;
export type OwnerOriginalTruth = Awaited<ReturnType<typeof readOwnerOriginalTruth>>;
/** Chronology is independent of source, type, UUID, time and presentation digest. Preserve all live conflicts. */
export declare function currentOwnerState(originals: readonly OwnerOriginalTruth[]): {
    status: 'unready';
    reason: 'unsequenced' | 'unpinned';
} | {
    status: 'complete';
    state: {
        original: string;
        id: string;
        sequence: bigint;
        pin: LibraryProfilePin;
    } | null;
};
export {};
