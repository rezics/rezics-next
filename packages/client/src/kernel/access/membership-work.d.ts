import type { MembershipWorkInput, MembershipWorkResult, MembershipWorkflowPorts } from '@rezics/auth-contract';
import type { WorkClient } from '../work/client.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import { type RealmMembershipAuthority, type MembershipReservation } from './membership-inverse.ts';
import { type RealmMembershipTransition } from './realm-membership-transition.ts';
import type { Access } from '../request/access.ts';
import { type LifecycleRequest } from './lifecycle.ts';
export declare class MembershipWorkConflictError extends Error {
    readonly code = "membership_work_conflict";
    constructor();
}
export declare class MembershipAuthorizationUnavailableError extends Error {
    readonly code = "membership_authorization_unavailable";
    constructor();
}
export declare class RealmMembershipUnavailableError extends Error {
    readonly code = "realm_membership_unavailable";
    constructor();
}
export type MembershipAuthorization = (reference: string, input: MembershipWorkInput) => Promise<LifecycleRequest>;
/** Installed by the owning Realm module. Following a Realm has no operation here. */
export type RealmMembershipCommands = {
    authority: RealmMembershipAuthority;
    cancel?(reservation: RealmMembershipTransition, key: string): Promise<unknown>;
    certifyLegacy?(reservation: RealmMembershipTransition, key: string): Promise<'published' | 'cancelled'>;
    /** Enqueue check and later step resolution for a Realm principal. */
    authorize(reference: string, input: MembershipWorkInput): Promise<LifecycleRequest>;
    publish(context: LifecycleRequest, input: Extract<MembershipWorkInput, {
        kind: 'membership';
    }>, reservation: MembershipReservation, key: string): Promise<unknown>;
    terminalize(reservation: MembershipReservation, key: string): Promise<unknown>;
};
type MembershipWorkContext = Pick<WorkContext, 'pool' | 'env'>;
type Options = {
    authorize?: MembershipAuthorization;
    access?: Access;
    realm?: RealmMembershipCommands;
};
/** Native Access-only ports. Direct component construction defers approval
 * configuration until use; WorkModule registration validates it eagerly. */
export declare function createMembershipWorkPorts(context: MembershipWorkContext, options?: Options): MembershipWorkflowPorts<LifecycleRequest>;
export declare function registerAccounts(context: WorkContext, ports?: MembershipWorkflowPorts<LifecycleRequest>): void;
export declare function createAccountsWorkModule(options?: Options): WorkModule;
export declare const accountsWorkModule: WorkModule;
/** Caller creates/closes the enqueue-only client through createWorkClient.
 * Input must contain only an opaque durable authorization reference. */
export declare function enqueueMembership(client: WorkClient, workflowId: string, input: MembershipWorkInput): Promise<import("@dbos-inc/dbos-sdk").WorkflowHandle<MembershipWorkResult>>;
export {};
