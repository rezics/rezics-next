import type { ReadContext } from './model.ts';
import type { HostedChapterTarget, HostedDependencies } from './hosted-chapters-model.ts';
export type HostedPointPublicEligibility = Readonly<{
    /** Recheck the original native observations. A false result is a private refusal. */
    final(): Promise<boolean>;
}>;
/**
 * Prepare public eligibility independently of the private command admission.
 * The caller supplies only newly selected chapter targets; unchanged public
 * targets are intentionally outside this bounded proof. Metadata reads load no
 * revision bodies and retain the native anonymous Post, ancestry and Access
 * checks for a later recheck.
 */
export declare function prepareHostedPointPublicEligibility(deps: HostedDependencies, catalogueOpening: HostedChapterTarget, newlySelectedTargets: readonly HostedChapterTarget[], context: ReadContext): Promise<HostedPointPublicEligibility | null>;
