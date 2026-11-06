/** Static cost declarations for one ordinary Collection members page. */
import { type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './contract/work-dimensions.ts';
export declare const ORDINARY_COLLECTION_PAGE_LIMIT = 100;
export declare const ORDINARY_COLLECTION_PREFIX_ROUNDS = 3;
export declare const ORDINARY_COLLECTION_PREFIX_GROUP_LIMIT = 100;
export declare const ORDINARY_COLLECTION_DRIVER_COUNT = 6;
export declare const ORDINARY_COLLECTION_ALIAS_LIMIT = 100;
export type OrdinaryCollectionPagePlan = Readonly<{
    limit: number;
    view: 'BASIC' | 'FULL';
    rounds: number;
    prefixGroupLimit: number;
    driverCount: number;
    aliasLimit: number;
    candidateLimit: number;
    sourceBound: Bound;
    total: Bound;
}>;
/**
 * The finite direct-reader producer uses c=min(600, 6L+3), matching its existing ownerQueryWork ceiling.
 * Its fixed term covers the two Source preparations/currentness passes, identity and authority checks, and
 * transaction controls. Each admitted candidate carries the existing 16-row/8-point/8-witness producer cost.
 * FULL adds one bounded list-facts batch per disclosed member. Prefixes remain at most three rounds of 100;
 * canonical groups and the six Source drivers retain their existing structural caps.
 */
export declare function ordinaryCollectionPagePlan(limit: number, view?: 'BASIC' | 'FULL'): OrdinaryCollectionPagePlan;
/** Adapter edge for the existing eight-axis native observer. Ordinary pages declare zero engine requests. */
export declare function ordinaryPageWorkDimensions(bound: Bound): WorkDimensions;
