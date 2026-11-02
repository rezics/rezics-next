import { type DiscoveryFilterDocument, type FilterRelease } from '@rezics/filter';
import type { DiscoveryRegistry, DiscoveryRequest } from './discovery.ts';
export type MixedDiscoveryRequest = DiscoveryRequest & {
    kindPage?: {
        limit: number;
        cursor?: string;
    };
    kindCountLeaf?: number;
};
/** Admission precedes any native enumeration. Saved/private domains remain closed here. */
export declare function admitDiscoveryRequest(request: MixedDiscoveryRequest, registry: DiscoveryRegistry, release: FilterRelease): {
    text: import("./text.ts").TextNode | undefined;
    filter: DiscoveryFilterDocument | undefined;
    countFilter: DiscoveryFilterDocument | undefined;
    sort: "id" | "name" | "relevance";
    limit: number;
    kindLimit: number;
    options: import("./hits.ts").HitOptions;
    languages: readonly string[];
    bindingRequest: {
        representation: string;
        text: string | null;
        filter: DiscoveryFilterDocument | null;
        sort: "id" | "name" | "relevance";
        limit: number;
        languages: readonly string[];
        descriptions: boolean;
        properties: readonly string[];
        kindLimit: number;
        kindCountLeaf: number | null;
        spaceId: string | null;
    };
};
/** Classify the opt-in grammar at the existing gate; the legacy parser must never see kind.in. */
export declare function requiresAdvancedDiscoverySearch(request: MixedDiscoveryRequest): boolean;
