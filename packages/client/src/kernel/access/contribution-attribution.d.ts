import type { ContributionAttribution, DeletedContributionAttribution } from './contract/index.ts';
export { ContributionAttributionSchema } from './contract/index.ts';
export type { ContributionAttribution, LiveContributionAttribution, DeletedContributionAttribution, } from './contract/index.ts';
/** Input comes from the owner's current public projection, never a guessed lifecycle state. */
export type ContributionIdentity = {
    readonly id?: string;
    readonly accountId?: string;
    readonly kind?: string;
    readonly state?: string;
    readonly displayName?: string | null;
};
/** Only authoritative deletion can remove the identity in favor of a deletion label.
 * Pending/missing identities and unavailable lookups carry no lifecycle assertion.
 * Suspension remains a live public attribution, as on the account IDs surface.
 */
export declare function contributionAttribution(identity: ContributionIdentity | null | undefined): ContributionAttribution;
/** Observed public identity for Log and Collection views: pending or missing stays unknown. */
export declare function contributionFromPublicIdentity(identity: ContributionIdentity | null | undefined): ContributionAttribution;
/** An absent id alone cannot establish deletion on a partially assembled public view. */
export declare function contributionDeleted(value: Pick<ContributionIdentity, 'id' | 'displayName'> | null | undefined): value is DeletedContributionAttribution;
