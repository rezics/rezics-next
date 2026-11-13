import type { ReadContext } from './model.ts';
import type { AccessClient } from '../request/access.ts';
import type { HostedChapterTarget, HostedDependencies } from './hosted-chapters-model.ts';
export type HostedPublicationAuthorityObservation = Readonly<{
    authorId: string;
    licence: string;
    homes: readonly number[];
}>;
export type HostedPointPublicEligibility = Readonly<{
    /** Recheck the original native observations. A false result is a private refusal. */
    final(): Promise<boolean>;
}>;
export type HostedPointDisclosureEligibility = Readonly<{
    /** Recheck public sources and exact private-source consent in the Book transaction. */
    final(client: AccessClient): Promise<boolean>;
}>;
/**
 * Prepare public eligibility independently of the private command admission.
 * The caller supplies only newly selected chapter targets; unchanged public
 * targets are intentionally outside this bounded proof. Metadata reads load no
 * revision bodies and retain the native anonymous Post, ancestry and Access
 * checks for a later recheck.
 */
export declare function prepareHostedPointPublicEligibility(deps: HostedDependencies, catalogueOpening: HostedChapterTarget, newlySelectedTargets: readonly HostedChapterTarget[], context: ReadContext): Promise<HostedPointPublicEligibility | null>;
/**
 * Observe one exact target through current anonymous public eligibility or
 * exact catalogue consent. It reads metadata only, then records every native
 * home whose state can close the proof: source, account, Board, Realm and Space.
 * The caller must have captured its fixed home vector before calling this.
 */
export declare function observeHostedPublicationActivationTarget(deps: HostedDependencies, input: Readonly<{
    catalogueId: string;
    activationRevisionId: string;
    target: HostedChapterTarget;
    occurrenceId: string;
    additionalAuthorityIds?: readonly string[];
    expectedAuthorId?: string;
    expectedLicence?: string;
    opening?: boolean;
}>, context: ReadContext): Promise<HostedPublicationAuthorityObservation | null>;
/**
 * Prepare the public catalogue opening and each changed exact target. Public
 * targets retain their anonymous Access observation; a private opening can use
 * only existing exact catalogue-scoped consent. Commit rechecks both the
 * source incarnation and issued consent row through Content's native exports.
 */
export declare function prepareHostedPointDisclosureEligibility(deps: HostedDependencies, catalogueOpening: HostedChapterTarget, catalogueId: string, newlySelectedTargets: readonly HostedChapterTarget[], context: ReadContext): Promise<HostedPointDisclosureEligibility | null>;
