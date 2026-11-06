/** identityEpochStore.readJob: owner row, job, and at most three ACK rows. */
export declare function IDENTITY_EPOCH_JOB_READ_DECLARATION(): Readonly<{
    engineRequests: 0;
    work: Readonly<{
        candidateKeys: 0;
        nativeRows: number;
        identityMetadataRows: 0;
        nativePoints: number;
        witnessKeys: 0;
        statements: number;
        bytes: number;
        emptySeeks: number;
    }>;
}>;
/** Complete-ACK reread used by original-source publication: native step, job, empty outstanding, existing ACK.
 * Insert-and-event is a Mapping/Search/Library producer body, not this receiving walk. */
export declare function IDENTITY_EPOCH_STEP_RECONCILE_DECLARATION(): Readonly<{
    engineRequests: 0;
    work: Readonly<{
        candidateKeys: 0;
        nativeRows: number;
        identityMetadataRows: 0;
        nativePoints: number;
        witnessKeys: 0;
        statements: number;
        bytes: number;
        emptySeeks: number;
    }>;
}>;
