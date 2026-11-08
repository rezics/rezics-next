/** Pure progress-operation bound arithmetic. SQL texts arrive as catalog values; this module imports none of them. */
import { type Bound } from '@rezics/bounds';
import { type ProgressOperationCatalog, type SessionCommandOriginal, type SessionOperationKind, type SessionReadInput, type SessionReadKind, type SessionWork } from '../contract/index.ts';
export { SESSION_LIMITS } from '../contract/index.ts';
export declare function sessionWorkOf(bound: Bound): SessionWork;
export declare function boundOf(work: SessionWork): Bound;
export declare function sessionBytesWork(bytes: number): Bound;
type Shape = Readonly<{
    keys: number;
    rows: number;
    points: number;
    seeks: number;
    output: number;
    rowBytes: number;
}>;
declare const point: (rowBytes: number) => Shape;
export declare function retainSessionOperands<I>(input: I): I;
export declare function statementWork(sql: string, inputBytes: number, shape: Shape, nested?: Bound): Bound;
export declare function createProgressOperationBounds(catalog: ProgressOperationCatalog): {
    sessionBytes: number;
    responseSessionBytes: number;
    factBytes: number;
    journalBytes: number;
    unitBytes: number;
    changeBytes: number;
    pinBytes: number;
    point: typeof point;
    childFence: () => Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    progressRefresh: () => Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sessionMutationEffects: () => Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    statementWork: typeof statementWork;
    sessionBytesWork: typeof sessionBytesWork;
    sessionPresentationWork: (measures: number, sessions?: number) => Bound;
    sessionCoreCommandAttemptWork: (kind: string, accountId: string, receiptKeys: number, response: object) => Bound;
    sessionCommandPlan: (kind: SessionOperationKind, original: SessionCommandOriginal, receiptKeys: number, preparesSource?: boolean, durationMs?: number) => {
        kind: SessionOperationKind;
        original: SessionCommandOriginal;
        total: Bound;
    };
    sessionSnapshotWork: (accountId: string) => Bound;
    sessionPartitionWork: (partition: number) => Bound;
    sessionReleaseWork: (digest: string, active?: boolean) => Bound;
    sessionSourceWork: (subjectId: string, withProfile: boolean) => Bound;
    sessionHeadWork: (input: {
        route: number;
        account_id: string;
        subject_id: string;
    }) => Bound;
    sessionActivityWork: (input: {
        route: number;
        account_id: string;
        subject_id: string;
        time: string;
        completed: boolean;
    }) => Bound;
    sessionShelfWork: (route: number, accountId: string, counters: boolean) => Bound;
    sessionProfileMigrationWork: (route: number, accountId: string) => Bound;
    sessionReadTimeWork: () => Bound;
    sessionReadOperationPlan: (kind: SessionReadKind, accountId: string, input: SessionReadInput) => {
        kind: SessionReadKind;
        original: SessionReadInput;
        total: Bound;
    };
    sessionWorkOf: typeof sessionWorkOf;
};
export type ProgressOperationBounds = ReturnType<typeof createProgressOperationBounds>;
