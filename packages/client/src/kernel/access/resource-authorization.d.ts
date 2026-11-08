import { type AuthoritativeTime, type CommandAuthorization } from '../command/command.ts';
import type { ResourceEligibility } from './eligibility.ts';
import { type ResourcePage, type Access, type AccessClient, type AccessContext, type Actor, type Resource } from './check.ts';
/** Trusted server binding to the authorization resource. validate checks THAT
 * anchor's existence and domain prerequisites at command T on its supplied client;
 * it is never a request-supplied callback or an authorization formula.
 */
export type AuthorizationAnchor = Readonly<{
    resource: Readonly<Resource>;
    validate(client: AccessClient, time: AuthoritativeTime): Promise<boolean>;
}>;
export type ResourceAuthorizationContext = AccessContext & {
    /** Actual target command partition, independent of the authority anchor's partition. */
    partition: number;
};
export type ResourceAuthorizationInput = {
    access: Access;
    actor: Actor;
    action: string;
    anchor: AuthorizationAnchor;
    context: ResourceAuthorizationContext;
};
/** Trusted whole-page existence/domain validation, in one owning-module statement. */
export type AuthorizationAnchorPage = ResourcePage & Readonly<{
    validate(client: AccessClient, time: AuthoritativeTime): Promise<boolean>;
}>;
export type ResourceAuthorizationPageInput = Omit<ResourceAuthorizationInput, 'anchor'> & {
    anchor: AuthorizationAnchorPage;
};
/** One attempt, exact immutable id set, one formula, all resources required. */
export declare function resourceAuthorizationPage(input: ResourceAuthorizationPageInput): CommandAuthorization;
/** Anonymous commands require exact principal attribution and opaque domain eligibility. */
export type AnonymousResourceAuthorizationInput = Omit<ResourceAuthorizationInput, 'actor' | 'anchor'> & {
    actor: Extract<Actor, {
        kind: 'anonymous';
    }>;
    anchor: AuthorizationAnchor & {
        resource: Readonly<Resource & {
            eligibility: ResourceEligibility;
        }>;
    };
};
export declare class ResourceAuthorizationUnavailableError extends Error {
    constructor();
}
/** Prepare bounded actor/principal/group evidence for every attempt, then validate
 * the trusted authority anchor and run the sole Access formula at that attempt's
 * T. Release that connection before the executor checks out the target partition.
 * The opaque, single-use proof permits execution only for the prepared basis,
 * authority, action, target partition, live attempt and evidence deadline.
 *
 * Stable tuple/upsert targets need no resource UUID or unique INSERT. This helper
 * never mints creationCapability; parentCreationAuthorization adds that proof.
 * Protected platform commands supply the seeded Global Context anchor (route 0,
 * id 00000000-0000-8000-8000-000000000000) and require real account grants/scopes.
 * Anonymous admission requires action-bound domain eligibility and the installed
 * catalogue, checked by that same formula. Receipt replay supplies no authority.
 *
 * Cost includes the owning module's exact existence/revision validation seek:
 * bounded actor inverses and matched group anchors, then one authority anchor,
 * O((1 + K) log G + L log R), K <= 1000 per account. Anonymous K=0 adds
 * bounded O(H) container evidence and one domain seek. No target read or ACL scan.
 */
export declare function resourceAuthorization(input: AnonymousResourceAuthorizationInput): CommandAuthorization;
export declare function resourceAuthorization(input: ResourceAuthorizationInput): CommandAuthorization;
