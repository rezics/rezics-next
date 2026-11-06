/** Closed Access work axes and finite call bounds. These allocate no ledger. */
export declare const ACCESS_WORK_AXES: readonly ['keys', 'points', 'witnesses', 'rows', 'bytes', 'emptySeeks'];
export type AccessWorkAxis = (typeof ACCESS_WORK_AXES)[number];
export type AccessWork = {
    readonly keys: number;
    readonly points: number;
    readonly witnesses: number;
    readonly rows: number;
    readonly bytes: number;
    readonly emptySeeks: number;
};
export declare const EMPTY_ACCESS_WORK: AccessWork;
/** Eight-axis original-work ledger, structurally compatible with Collection Source. */
export declare const ORIGINAL_WORK_AXES: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "nativePoints", "witnessKeys", "statements", "bytes", "emptySeeks"];
export type OriginalWorkAxis = (typeof ORIGINAL_WORK_AXES)[number];
export type AccessWorkDimensions = {
    readonly candidateKeys: number;
    readonly nativeRows: number;
    readonly identityMetadataRows: number;
    readonly nativePoints: number;
    readonly witnessKeys: number;
    readonly statements: number;
    readonly bytes: number;
    readonly emptySeeks: number;
};
export declare const EMPTY_ACCESS_WORK_DIMENSIONS: AccessWorkDimensions;
/** A selected original has an absolute five-second lifetime. */
export declare const IDENTITY_ORIGINAL_DEADLINE_MS = 5000;
export declare const ACCESS_RESOURCE_PAGE_LIMIT = 100;
export declare const ACCESS_AVATAR_BATCH_LIMIT = 256;
export declare const ACCESS_MEMBERSHIP_INVERSE_LIMIT = 64;
export declare const ACCESS_PARTITION_COUNT = 4096;
export declare const ACCESS_ANONYMOUS_PRINCIPAL_ID = "00000000-0000-8000-8000-000000000000";
export declare const ACCESS_IDENTITY_OBSERVATION_MS = 180000;
export declare const ACCESS_HANDLE_CLAIM_MIN = 3;
export declare const ACCESS_HANDLE_CLAIM_MAX = 64;
export declare const ACCESS_WORKFLOW_KEY_MIN = 1;
export declare const ACCESS_WORKFLOW_KEY_MAX = 255;
export declare const ACCESS_KIND_AUDIENCE_STATEMENT_COUNT = 13;
export declare const ACCESS_KIND_AUDIENCE_NATIVE_POINTS = 4;
export type AccessWorkDeclaration = {
    readonly work: AccessWorkDimensions;
    readonly engineRequests: 0;
};
