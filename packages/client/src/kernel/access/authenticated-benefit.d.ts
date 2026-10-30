import { type AuthoritativeTime } from '../command/command.ts';
export type ContentEditionBenefit = Readonly<{
    kind: 'content-edition';
    resourceType: 'content.edition';
    resource: Readonly<{
        route: number;
        id: string;
    }>;
    version: Readonly<{
        revisionId: string;
        sha256: string;
    }>;
    action: 'edition:read';
}>;
declare const buyerFact: unique symbol;
export type ContentEditionBuyerFact = {
    readonly [buyerFact]: true;
};
export type ContentEditionBuyerFactInput = Readonly<{
    benefit: ContentEditionBenefit;
    buyerAccountId: string;
    entitlementId: string;
    entitlementRevision: number;
    time: AuthoritativeTime;
    deadline: number;
}>;
/** Internal native issuer; Commerce supplies validated current entitlement bindings. */
export declare function createContentEditionBuyerFact(input: ContentEditionBuyerFactInput): ContentEditionBuyerFact;
export type ContentEditionBuyerFactReader = (input: Readonly<{
    benefit: ContentEditionBenefit;
    buyerAccountId: string;
    time: AuthoritativeTime;
    deadline: number;
}>) => Promise<ContentEditionBuyerFact | null>;
/** Copy only the exact native selector; this is never entitlement evidence. */
export declare function copyContentEditionBenefit(benefit: ContentEditionBenefit): ContentEditionBenefit;
export declare function contentEditionBenefitBinding(benefit: ContentEditionBenefit): string;
/** Final native identity check. Structural, cloned and expired facts never match. */
export declare function matchesContentEditionBuyerFact(fact: unknown, input: Parameters<ContentEditionBuyerFactReader>[0]): fact is ContentEditionBuyerFact;
export {};
