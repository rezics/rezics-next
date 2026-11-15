import { type AuthoritativeTime } from '../command/command.ts';
/** A Post benefit names the stable Post/action; Content still selects each revision. */
export type ContentPostBenefit = Readonly<{
    kind: 'content-post';
    resourceType: 'content.post';
    resource: Readonly<{
        route: number;
        id: string;
    }>;
    action: 'post:read';
}>;
/** A fixed-edition benefit retains the exact immutable revision and digest. */
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
/** Closed Commerce-to-Access target contract; adding a target requires an explicit owner arm. */
export type AuthenticatedContentBenefit = ContentPostBenefit | ContentEditionBenefit;
declare const editionBuyerFact: unique symbol;
declare const postBuyerFact: unique symbol;
export type ContentEditionBuyerFact = {
    readonly [editionBuyerFact]: true;
};
export type ContentPostBuyerFact = {
    readonly [postBuyerFact]: true;
};
export type ContentBuyerFact = ContentEditionBuyerFact | ContentPostBuyerFact;
export type ContentEditionBuyerFactInput = Readonly<{
    benefit: ContentEditionBenefit;
    buyerAccountId: string;
    entitlementId: string;
    entitlementRevision: number;
    time: AuthoritativeTime;
    deadline: number;
}>;
export type ContentPostBuyerFactInput = Readonly<{
    benefit: ContentPostBenefit;
    buyerAccountId: string;
    entitlementId: string;
    entitlementRevision: number;
    time: AuthoritativeTime;
    deadline: number;
}>;
export type ContentEditionBuyerFactReader = (input: Readonly<{
    benefit: ContentEditionBenefit;
    buyerAccountId: string;
    time: AuthoritativeTime;
    deadline: number;
}>) => Promise<ContentEditionBuyerFact | null>;
export type ContentPostBuyerFactReader = (input: Readonly<{
    benefit: ContentPostBenefit;
    buyerAccountId: string;
    time: AuthoritativeTime;
    deadline: number;
}>) => Promise<ContentPostBuyerFact | null>;
/** Internal native issuer; Commerce supplies a validated current exact entitlement binding. */
export declare function createContentEditionBuyerFact(input: ContentEditionBuyerFactInput): ContentEditionBuyerFact;
/** Internal native issuer; Commerce supplies the stable Post key, without a revision selector. */
export declare function createContentPostBuyerFact(input: ContentPostBuyerFactInput): ContentPostBuyerFact;
/** Copy only the exact native selector; this is never entitlement evidence. */
export declare function copyContentEditionBenefit(benefit: ContentEditionBenefit): ContentEditionBenefit;
export declare function copyContentPostBenefit(benefit: ContentPostBenefit): ContentPostBenefit;
/** Content derives this exact routed key from its already selected native Post row. */
export declare function contentPostBenefitForPost(postId: string): ContentPostBenefit;
/** Exhaustive copy of the deliberately small native target union. */
export declare function copyAuthenticatedContentBenefit(benefit: AuthenticatedContentBenefit): AuthenticatedContentBenefit;
export declare function contentEditionBenefitBinding(benefit: ContentEditionBenefit): string;
export declare function contentPostBenefitBinding(benefit: ContentPostBenefit): string;
export declare function authenticatedContentBenefitBinding(benefit: AuthenticatedContentBenefit): string;
/** Final exact-edition identity check. Structural, cloned and expired facts never match. */
export declare function matchesContentEditionBuyerFact(fact: unknown, input: Parameters<ContentEditionBuyerFactReader>[0]): fact is ContentEditionBuyerFact;
/** Final stable-Post identity check. A revision change cannot widen this selector to another Post. */
export declare function matchesContentPostBuyerFact(fact: unknown, input: Parameters<ContentPostBuyerFactReader>[0]): fact is ContentPostBuyerFact;
export {};
