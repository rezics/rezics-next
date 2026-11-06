/** Ordinary Collection page arithmetic. Caps match the Library README formula c = min(600, 6L + 3). */
import { type Bound } from '@rezics/bounds';
import type { WorkDimensions } from '../contract/work-dimensions.ts';
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
export declare function ordinaryCollectionPagePlan(limit: number, view?: 'BASIC' | 'FULL'): OrdinaryCollectionPagePlan;
export declare function ordinaryPageWorkDimensions(bound: Bound): WorkDimensions;
