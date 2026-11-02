/** Shared identity failure without importing the store/closure/bootstrap cycle.
 * The store re-exports this exact class, preserving every caller's instanceof.
 */
export declare class IdentityEpochStoreError extends Error {
    readonly code: string;
    constructor(code: string, detail: string);
}
/** Cleanup can fail independently at several homes. Keep the source failure
 * and every attempted release failure without replacing either with success.
 */
export declare class IdentityTerminalClaimReleaseError extends AggregateError {
    readonly code = "identity_epoch_unavailable";
    constructor(errors: readonly unknown[], cause: unknown);
}
