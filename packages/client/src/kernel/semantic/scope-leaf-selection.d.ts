/** Private Source selection and bounded native IO; not a matcher or permission resolver. */
import type { IndexedStatement } from '../search/source.ts';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { AccessWorkAccounting, type AccessWork } from '../access/work.ts';
import { type OperationalTransaction } from '../command/operational.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
export declare const sourceObject: (value: unknown) => value is Record<string, unknown>;
export declare function selectedRank(value: unknown): 'normal' | 'preferred' | null;
/** The Global adoption rank, never the proposal body's rank. Shared with SubjectSource. */
export declare function selectedCandidate(value: unknown): {
    candidate: string;
    rank: 'normal' | 'preferred';
} | null;
export declare const sourceBytes: (value: unknown) => number;
export declare class LeafReservationUnavailable extends Error {
}
/** The narrow native projection shared by Source Type evidence. This is raw
 * dependency data, not permission, admission, EOF or a transferable certificate.
 * Its caller must already hold this exact admitted native home; it never checks
 * out a connection or retains a transaction across foreign preparation.
 */
export type NativeKindTypeAnchor = Readonly<{
    subject_id: string;
    present: boolean;
    writer_enrolled: boolean;
    writer_version: string;
    visibility: string | null;
    security_revision: string | null;
    current_release: string | null;
    type: string | null;
    type_oversized: boolean;
    revision: number | null;
    revision_transaction: string | null;
    revision_epoch: number | null;
    revision_position: string | null;
    redirect: string | null;
    redirect_sequence: number | null;
    redirect_transaction: string | null;
    redirect_epoch: number | null;
    redirect_position: string | null;
    account_id: string | null;
}>;
export declare const KIND_TYPE_MAX_BYTES = 4096;
/** Eight exact/indexed head points: subject, fence, revision, revision write
 * basis, redirect, redirect write basis and agent link (seven), plus the wanted
 * key. Two additional exact provenance row locks serialize native write-basis
 * erasure/updates. No history payload, candidate, label, account or tuple hydration.
 */
export declare function kindTypeAnchorFootprint(inputBytes: number): WorkDimensions;
/** INSERT/conflict enrollment plus the exact fence point. The row lock is held
 * by the caller's native transaction; absent keys use the same full declaration.
 */
export declare function kindTypeAnchorLockFootprint(inputBytes: number): WorkDimensions;
export declare function readNativeKindTypeAnchor(client: OperationalTransaction, input: Readonly<{
    route: number;
    subjectId: string;
    includeType: boolean;
}>, work: NativeCollectionWork, deadline: number): Promise<NativeKindTypeAnchor>;
/** Local native comparison only. Both the original and terminal, including a
 * negative key, must pass this under their actual home fence. A foreign expected
 * key requires its own admitted invocation; it cannot be checked from Source by
 * opening another pool. This comparison alone grants no audience authority.
 */
export declare function verifyNativeKindTypeAnchor(client: OperationalTransaction, input: Readonly<{
    route: number;
    expected: NativeKindTypeAnchor;
    includeType: boolean;
}>, work: NativeCollectionWork, deadline: number): Promise<boolean>;
/** One ledger, including Access and every failed/discarded native operation. */
export declare class LeafNativeWork {
    readonly budget: AccessWork;
    readonly deadline: number;
    private reserved;
    readonly accounting: AccessWorkAccounting;
    constructor(budget: AccessWork, deadline: number);
    remaining(axis: keyof AccessWork): number;
    usage(): AccessWork;
    /** All counts describe explicit native plans: exact probes, <=33 compact
     * operations or <=32 adoption entries. They are not returned-row estimates.
     * Native row reservations cannot be refunded; bytes include rejected data.
     * Bypass reylo's periodic catalogue checks using its compiled typed statement.
     */
    query<I extends Record<string, unknown>, R extends QueryResultRow>(client: PoolClient, statement: {
        sql: string;
        params: readonly string[];
        '~reylo': {
            input: I;
            element: R;
        };
    }, input: I, plan: {
        keys: number;
        points: number;
        rows: number;
        witnesses?: number;
        outputBytes?: number;
    }): Promise<R[]>;
    snapshot<T>(pool: Pool, route: number, read: (client: PoolClient) => Promise<T>): Promise<T>;
    private transaction;
    anchor(client: PoolClient, route: number, subject: string): Promise<{
        visibility: "visible" | "hidden" | "taken_down";
        security_revision: string;
        type: string | null;
        current_release: string;
        revision: number | null;
        redirect: string | null;
    } | null>;
    slot(client: PoolClient, route: number, subject: string, id: string): Promise<{
        operation: "assert" | "retract" | "expand" | null;
        log_seq: number | null;
        head: number | null;
        mode: "inherit" | "replace" | "suppress" | null;
        selected: number | null;
    }>;
    compact(client: PoolClient, route: number, subject: string, id: string, after: string | null): Promise<{
        after: string;
        candidate_id: string | null;
        slot_id: string;
    } | null>;
    selected(client: PoolClient, route: number, subject: string, id: string, ordinal: number): Promise<{
        candidate: string;
        rank: 'normal' | 'preferred';
    } | null>;
    membership(client: PoolClient, route: number, subject: string, id: string, witness: string): Promise<{
        candidate: string;
        rank: 'normal' | 'preferred';
    } | null>;
    pair(client: PoolClient, route: number, subject: string, property: string, value: string, phase: 'compact' | 'witness', after: string | null): Promise<{
        after: string;
        candidate_id: string | null;
        slot_id: string;
    } | null>;
    locator(client: PoolClient, route: number, subject: string, witness: string): Promise<string | null>;
    candidate(client: PoolClient, route: number, subject: string, witness: string, maxBytes: number): Promise<{
        slot_id: string;
        property: string | null;
        expanded: boolean;
        operation: string | null;
        release: string | null;
        body_bytes: number;
        body: unknown | null;
        revision: number | null;
        source_bytes: number;
        source: unknown;
    } | null>;
    concealed(client: PoolClient, route: number, subject: string, witness: string): Promise<boolean>;
    release(pool: Pool, digest: string, names: readonly string[]): Promise<Release['properties']>;
}
export type SourceStatementRow = {
    subject_id: string;
    property: string;
    rank: 'normal' | 'preferred';
    body: unknown;
    release: string;
    ordinal: number;
};
export declare function indexedStatement(row: SourceStatementRow, release: Release): IndexedStatement | null;
export declare function normalizeSourceStatement(property: string, body: unknown, properties: Release['properties']): IndexedStatement | null;
