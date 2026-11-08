/** Shared Access refusals. Native commands and consumers use the same constructor identities. */
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
export declare class ApprovalIdentityDeniedError extends Error {
    readonly status = 403;
    constructor();
}
export declare class DurableInitiatorUnavailableError extends Error {
    constructor();
}
export declare class PlatformClosedError extends Error {
    constructor();
}
export declare class LifecycleDeniedError extends Error {
    constructor();
}
/** Access could not finish; absence of evidence is not evidence of a denial. */
export declare class AccessUnavailableError extends Error {
    readonly reason: 'deadline' | 'overloaded' | 'contention';
    constructor(reason: 'deadline' | 'overloaded' | 'contention');
}
export declare class CommandUnavailableError extends Error {
    readonly reason: 'fenced' | 'moved' | 'contention' | 'deadline' | 'overloaded';
    readonly partition: number;
    readonly movedTo: string | null;
    constructor(reason: CommandUnavailableError['reason'], partition: number, movedTo?: string | null);
}
/** Missing native admission evidence is pending, never an empty inventory or an ACK. */
export declare class LiveCopyPendingError extends Error {
}
