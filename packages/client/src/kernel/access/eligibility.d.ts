import { type AccessWorkAccounting, type AccessWorkProducer } from './work.ts';
import type { AccessClient, AccessContext, Actor, Resource } from '../request/access.ts';
import { type AuthoritativeTime } from '../command/command.ts';
import type { PreparedAccessCheckInvocation } from '../request/access.ts';
import type { AccessWork } from './work.ts';
declare const resourceEligibility: unique symbol;
/** Server capability only; serialized input and structural copies carry no authority. */
export type ResourceEligibility = {
    readonly [resourceEligibility]: true;
};
export type ResourceIdentity = Readonly<Pick<Resource, 'route' | 'id'>>;
export type ResourceEligibilityPrepareContext = Readonly<{
    actor: Actor;
    action: string;
    resource: ResourceIdentity;
    pool: AccessContext['pool'];
    deadline: number;
    time?: AuthoritativeTime;
    work?: AccessWorkAccounting;
}>;
export type ResourceEligibilityVerifyContext<E> = Readonly<{
    client: AccessClient;
    actor: Actor;
    action: string;
    resource: ResourceIdentity;
    evidence: E;
    /** Authoritative server/database T, supplied by the evaluator. */
    at: string;
    deadline: number;
    time?: AuthoritativeTime;
    work?: AccessWorkAccounting;
}>;
export type ResourceEligibilityOptions<E> = Readonly<{
    /** Native owner declarations for these SAME callbacks, not an alternate evaluator. */
    work?: Readonly<{
        prepare: AccessWorkProducer<ResourceEligibilityPrepareContext, E>;
        verify: AccessWorkProducer<ResourceEligibilityVerifyContext<E>, boolean>;
    }>;
    resource: Resource;
    action: string;
    /** Trusted owning-module code; runs before resource checkout. Gather bounded,
     * separately anchored container/revision evidence here. Missing evidence denies.
     */
    prepare(context: ResourceEligibilityPrepareContext): Promise<E>;
    /** Revalidate current domain state, revisions and the bound container chain on
     * the supplied resource client at T, with no nested checkout or cross-anchor join.
     * False disables only the floor. Throw for unavailable required disclosure or a
     * hard domain restriction so the independent grant branch also fails closed.
     */
    verify(context: ResourceEligibilityVerifyContext<E>): Promise<boolean>;
}>;
type Binding = Readonly<{
    actor: Actor;
    action: string;
    resource: Resource;
    deadline: number;
}>;
export type PreparedEligibilityVerify = ((client: AccessClient, at: string, time?: AuthoritativeTime, work?: AccessWorkAccounting) => Promise<boolean>) & {
    bound?(input: PreparedAccessCheckInvocation): AccessWork | undefined;
};
type Verify = PreparedEligibilityVerify;
/** Generic anonymous-action domain capability, never an authorization boolean.
 * Snapshot identity/action and callbacks without executing domain code. Command
 * callbacks prove that action's current prerequisites (including verified captcha
 * when required), not public readability of its newly created private resource.
 * Authentication alone never supplies those prerequisites.
 */
export declare function createResourceAnonymousEligibility<E extends {}>(options: Omit<ResourceEligibilityOptions<E>, 'prepare'> & {
    prepare(context: ResourceEligibilityPrepareContext): Promise<E | null | undefined>;
}): ResourceEligibility;
export declare function createResourceAnonymousEligibility<E>(options: ResourceEligibilityOptions<E>): ResourceEligibility;
/** Public-read form of the same capability and evaluator. The owning reader must
 * prove CURRENT publication and revisions of the resource AND its container chain
 * at T. Catalogue admission and authorship provide no publication authority.
 */
export declare const createResourcePublicEligibility: typeof createResourceAnonymousEligibility;
export declare class ResourceEligibilityUnavailableError extends Error {
    constructor();
}
/** A factory alone is never permission proof. Direct evaluation without the
 * evaluator's prepared actor/resource/deadline and authoritative T is unavailable.
 */
export declare function evaluateResourceEligibility(eligibility: ResourceEligibility, attempt?: {
    evidence: unknown;
    client: AccessClient;
    at: string;
    time?: AuthoritativeTime;
    work?: AccessWorkAccounting;
}): Promise<boolean>;
/** Prepare bounded owning-module evidence before resource checkout. Each check
 * binds the exact capability, actor, action, resource and deadline independently.
 * The returned verifier runs on EVERY attempt at the SQL formula's shared T.
 * Public readers must recheck publication and revisions for the resource and all
 * containers using O(H) anchored reads, where the owning route bounds H.
 * False leaves the independent grant/scope branch available. Missing evidence or
 * exceptions deny the whole check, including unavailable required disclosure.
 */
export declare function prepareAnonymousEligibility(binding: Binding, context: AccessContext): Promise<Verify | undefined>;
export {};
