/** Retained contributions disclose a current identity, a deletion label, or no available identity. */
export type LiveContributionAttribution = {
    readonly id: string;
    readonly kind: 'actor' | 'organization';
    readonly displayName: string | null;
};
export type DeletedContributionAttribution = {
    readonly displayName: 'Deleted account' | 'Deleted organization';
};
/** Null is unavailable/absent attribution. It never attests account deletion. */
export type ContributionAttribution = LiveContributionAttribution | DeletedContributionAttribution | null;
export declare function ContributionAttributionSchema(): import("typebox").TUnion<[import("typebox").TObject<{
    id: import("typebox").TString;
    kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
    displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>, import("typebox").TObject<{
    displayName: import("typebox").TUnion<[import("typebox").TLiteral<"Deleted account">, import("typebox").TLiteral<"Deleted organization">]>;
}>, import("typebox").TNull]>;
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
