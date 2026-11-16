import { CREDIT_SEARCH_LIMITS } from '../search/credit-search.ts';
export declare const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
export declare const SELECTED_UUID: RegExp;
export declare const encoder: TextEncoder;
export type CreditSearchCeilings = {
    pages: number;
    creditsPerPage: number;
    namesPerCreator: number;
    qualifiersPerCredit: number;
    nameBytes: number;
    documentBytes: number;
    pageBytes: number;
};
export type CreditCursor = {
    property: string;
    slot: string;
    candidate: string;
};
export type WorkHeader = {
    id: string;
    route: number;
    type: string;
    visibility: string;
    redirect: string | null;
    currentRelease: string | null;
    securityRevision: string;
    current_revision: number | null;
    selection_ready: boolean;
};
export type WorkCut = Readonly<{
    work: WorkHeader;
    generation: string;
    ready: boolean;
}>;
/** Port ceilings apply before nested creator expansion. Callers may only tighten them. */
export declare function installedLimits(input: typeof CREDIT_SEARCH_LIMITS): CreditSearchCeilings;
export declare const utf8Bytes: (value: unknown) => number;
export declare const isRecord: (value: unknown) => value is Record<string, unknown>;
export declare function digestOf(value: unknown): string;
/** Work header plus search canonical generation. Creator names live in nameRevision; paging stays stable. */
export declare function observationOf(cut: WorkCut): string;
export declare function selectedCursorOf(row: {
    property: string;
    slot_id: string;
    candidate_id: string;
}): string;
export declare function readCursor(after: string | null): CreditCursor | null | 'invalid';
export declare function sortQualifiers<T extends {
    property: string;
    value: string;
}>(items: readonly T[]): T[];
