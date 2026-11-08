import { Type as t } from 'typebox';
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
export declare function ContributionAttributionSchema(): t.TUnion<[t.TObject<{
    id: t.TString;
    kind: t.TUnion<[t.TLiteral<"actor">, t.TLiteral<"organization">]>;
    displayName: t.TUnion<[t.TString, t.TNull]>;
}>, t.TObject<{
    displayName: t.TUnion<[t.TLiteral<"Deleted account">, t.TLiteral<"Deleted organization">]>;
}>, t.TNull]>;
