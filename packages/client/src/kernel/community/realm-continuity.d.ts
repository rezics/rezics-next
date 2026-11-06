import { type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { type Actor, type Resource } from '../request/access.ts';
import { type RealmDependencies, type RealmContext } from './realm.ts';
export type RealmContinuity = Readonly<{
    ownershipState: 'owned' | 'orphaned';
    orphanedAt: string | null;
    claimEligibleAt: string | null;
    governanceReadOnly: boolean;
}>;
declare const lockedOwnership: unique symbol;
export type LockedRealmOwnershipSource = Readonly<{
    readonly [lockedOwnership]: true;
    realmId: string;
    ownershipState: 'owned' | 'orphaned';
    orphanedAt: string | null;
    claimEligibleAt: string | null;
}>;
/** Native source data, including removed Realms for mechanical erasure cleanup. */
export declare function lockRealmOwnershipSource(tx: CommandTransaction, realmId: string): Promise<LockedRealmOwnershipSource | null>;
/** Accounts' actually applied native erasure result is the sole decision authority. */
export declare function applyRealmOwnershipSuccession(tx: CommandTransaction, source: LockedRealmOwnershipSource, erasedAccountId: string): Promise<RealmContinuity>;
export declare function RealmReadOnlyError(): {
    new (): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
        readonly code: import("../http/problem-error.ts").ProblemCode;
        readonly detail: string | undefined;
        readonly errors: readonly import("../http/problem-error.ts").FieldError[] | undefined;
        readonly headers: Record<string, string> | undefined;
        readonly extensions: Readonly<Record<string, unknown>> | undefined;
        readonly effectStatus: 'not_applicable' | 'not_applied' | undefined;
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type RealmReadOnlyError = InstanceType<ReturnType<typeof RealmReadOnlyError>>;
export declare function realmContinuityView(row: {
    ownership_state: string;
    orphaned_at: string | null;
    claim_eligible_at: string | null;
}): RealmContinuity;
/** The transaction rechecks and locks the same native identity before receipt replay
 * or a new write. A concurrent succession cannot slip between this check and commit.
 * This guard consumes ordinary Access authorization; it grants no action itself.
 */
export declare function realmGovernanceAuthorization(authorization: CommandAuthorization, resource: Resource): CommandAuthorization;
export type RealmClaimRequest = Readonly<{
    realmId: string;
    requestId: string;
    state: 'pending';
    orphanedAt: string;
    claimEligibleAt: string;
    requestedAt: string;
}>;
/** Request review using the existing participation and read admission. Neither a
 * request nor expiry transfers a grant. Platform approval is a separate authority.
 */
export declare function requestRealmClaim(deps: RealmDependencies, actor: Actor, realmId: string, context: RealmContext): Promise<import("../command/command.ts").CommandOutcome<Readonly<{
    realmId: string;
    requestId: string;
    state: 'pending';
    orphanedAt: string;
    claimEligibleAt: string;
    requestedAt: string;
}>>>;
export {};
