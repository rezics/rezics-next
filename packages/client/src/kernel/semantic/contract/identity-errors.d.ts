/** Shared identity failure without importing the store/closure/bootstrap cycle.
 * The store re-exports this exact class, preserving every caller's instanceof.
 */
export declare class IdentityEpochStoreError extends Error {
    readonly code: string;
    constructor(code: string, detail: string);
}
