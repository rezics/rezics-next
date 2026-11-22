import type { Pool, PoolClient } from 'pg';
import type { HeldSubjectOriginal } from './public-filter-held-subject-originals.ts';
import { readPublicFilterCreationEvents, type PublicFilterCreationWindow } from './public-filter-creation-window.ts';
type Context = Readonly<{
    deadline: number;
}>;
type Member = Readonly<{
    job: string;
    bootstrap: string;
    birth: string;
}>;
type Page = Member & Readonly<{
    firstHome: number;
    endHome: number;
    ordinal: number;
}>;
type Inventory = {
    partition: number;
    epoch: number;
    receipt: string;
    commandHead: string;
    originals: HeldSubjectOriginal[];
    complete: boolean;
};
type Envelope = Awaited<ReturnType<typeof readPublicFilterCreationEvents>>['envelopes'][number];
type Window = Omit<PublicFilterCreationWindow, 'base' | 'through' | 'position'> & Readonly<{
    base: string;
    through: string;
    position: string;
}>;
type Cursor = {
    phase: 'inventory';
    partition: number;
    after: HeldSubjectOriginal | null;
} | {
    phase: 'window';
} | {
    phase: 'events';
    windows: readonly Window[];
};
type Obligation = {
    partition: number;
    epoch: number;
    position: string;
    ids: readonly string[];
};
type Step = {
    ordinal: number;
    phase: Cursor['phase'];
    complete: boolean;
    obligations: Obligation[];
    evidence: {
        inventory?: Inventory[];
        windows?: Window[];
        quiet?: [number, string[]][];
        envelopes?: readonly Envelope[];
        window?: Window;
    };
    next: Cursor | null;
};
/** Explicit producer admission on the original native job. The Search scheduler
 * keeps its ordinary protocol until the remaining owners qualify admission.
 */
export declare function openHeldSubjectPreparation(pool: Pool, input: Omit<Member, 'birth'>, context: Context): Promise<string>;
export declare function reserveHeldSubjectPreparation(db: PoolClient, input: Omit<Member, 'birth'>): Promise<string>;
/** Each result is addressed by the original membership, interval and ordinal.
 * No caller-provided key cursor, end position or event count can advance it.
 */
export declare function advanceHeldSubjectPage(pool: Pool, input: Page, context: Context): Promise<Step>;
export type HeldSubjectFrontier = Member & {
    firstHome: number;
    endHome: number;
    ordinal: number;
};
/** Search retains its own lock throughout this call. The writer comparison
 * happens outside Source transactions. If the process dies before the CAS,
 * its successor gets the same immutable obligations.
 */
export declare function reconcileHeldSubjectPage(pool: Pool, input: HeldSubjectFrontier, context: Context, settle: (obligation: Obligation) => Promise<void>, receiveCommittedCut?: () => Promise<number>): Promise<Step | undefined>;
/** Resolve every interval from the original birth. The producer can keep taking
 * retention cuts while the independent Source cursor waits for a writer.
 */
export declare function captureHeldSubjectRange(db: PoolClient, member: Member, start: number, count: number): Promise<undefined>;
/** Inventory commits before the writer comparison and the finite command ends.
 * The final transaction reopens each Access page before advancing Source. A
 * dense inventory or a nonempty bridge resumes at the retained exact ordinal.
 */
export declare function prepareHeldSubjectRange<T>(pool: Pool, member: Member, first: number, count: number, context: Context, inventoryOffer: (homes: number) => T, settle: (obligations: readonly Obligation[], offer: T) => Promise<boolean>, windowOffer: (homes: number) => void): Promise<boolean>;
export {};
