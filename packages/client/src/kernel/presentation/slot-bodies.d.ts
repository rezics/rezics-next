import type { PageRead } from '@rezics/composition';
export type ObservedSearchPage = {
    subjects: {
        id: string;
        type: string;
        labels: Record<string, string>;
        summary: unknown;
    }[];
    next: string | null;
};
export type ObservedMembersPage = {
    members: {
        kind: 'dynamic';
        subjectId: string;
        summary: unknown;
    }[];
    next: string | null;
};
/** Admit a Zone-composed TypeList page: unique canonical IDs, planned limit, opaque continuation. */
export declare function admitObservedSearchPage(read: PageRead, body: unknown): ObservedSearchPage | undefined;
/** Admit a Zone-composed Members page: unique canonical IDs, planned limit, opaque continuation. */
export declare function admitObservedMembersPage(read: PageRead, body: unknown): ObservedMembersPage | undefined;
/** Deduplicate overlapping/alias rows by canonical ID while keeping the first native occurrence. */
export declare function uniqueCanonicalRows<Row extends {
    id?: string;
    subjectId?: string;
}>(rows: readonly Row[]): Row[];
