/** Shared error identities without native command or HTTP initialization dependencies. */
export declare class ResourceAccessWriteDeniedError extends Error {
    constructor();
}
export declare class GrantDeniedError extends ResourceAccessWriteDeniedError {
    constructor();
}
/** Only the authorized, locked native Realm holder predicate may issue this refusal. */
export declare class RealmLastOwnerError extends GrantDeniedError {
    constructor();
}
