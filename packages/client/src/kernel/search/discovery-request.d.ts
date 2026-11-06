import { type DiscoveryFilterDocument, type FilterRelease } from '@rezics/filter';
import type { DiscoveryOwnerRegistry, DiscoveryRegistry } from './discovery.ts';
import type { DiscoveryRequest } from './discovery-api.ts';
import type { CreditQualifierOperand } from './credit-search-query.ts';
export type MixedDiscoveryRequest = DiscoveryRequest & {
    kindPage?: {
        limit: number;
        cursor?: string;
    };
    kindCountLeaf?: number;
};
/** Maximum engine rows admitted across one mixed Search page and its useful-page refills. */
export declare function discoveryCandidateScanBound(limit: number): number;
/** Same-credit qualifiers name released properties; item values are canonical UUIDs, like statement operands. */
export declare function admitCreditQualifiers(value: unknown, release: FilterRelease): CreditQualifierOperand[];
/** Copy bounded caller fields before the first await. Omitted keys stay omitted. */
export declare function ownDiscoveryRequest(request: MixedDiscoveryRequest): MixedDiscoveryRequest;
/** Admission precedes any native enumeration. Saved/private domains remain closed here. */
export declare function admitDiscoveryRequest(request: MixedDiscoveryRequest, registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>, release: FilterRelease): {
    text: import("@rezics/search-text").TextNode | undefined;
    filter: DiscoveryFilterDocument | undefined;
    countFilter: DiscoveryFilterDocument | undefined;
    sort: "id" | "name" | "rating" | "relevance";
    limit: number;
    kindLimit: number;
    kindCountLeaf: number | undefined;
    options: import("./hits.ts").HitOptions;
    languages: readonly string[];
    collectionDirectory?: Readonly<{
        presentationKind?: string;
        curator?: string;
        subject?: string;
        order: 'recent' | 'popular';
    }>;
    textField?: "credited_creator";
    creditQualifiers?: Readonly<{
        property: string;
        value: string;
    }>[];
    bindingRequest: {
        representation: string;
        text: string | null;
        filter: DiscoveryFilterDocument | null;
        sort: "id" | "name" | "rating" | "relevance";
        limit: number;
        languages: string[];
        descriptions: boolean;
        properties: string[];
        kindLimit: number;
        kindCountLeaf: number | null;
        spaceId: string | null;
        collectionDirectory?: Readonly<{
            presentationKind?: string;
            curator?: string;
            subject?: string;
            order: 'recent' | 'popular';
        }>;
        textField?: "credited_creator";
        creditQualifiers?: Readonly<{
            property: string;
            value: string;
        }>[];
    };
};
/** Classify the opt-in grammar at the existing gate; the legacy parser must never see kind.in. */
export declare function requiresAdvancedDiscoverySearch(request: MixedDiscoveryRequest): boolean;
