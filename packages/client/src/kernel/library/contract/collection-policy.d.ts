/** Library-owned Collection list residual and authorization-preparation shapes.
 * Access implements these; Library directory SQL binds only the admitted parameter map.
 */
import type { WorkDimensions } from './work-dimensions.ts';
/** Closed list residual after Access specialization. Directory SQL interpolates none of this. */
export type CollectionListFilter = Readonly<{
    status: 'ready';
    source: 'curator';
    parameters: Readonly<Record<string, never>>;
}> | Readonly<{
    status: 'ready';
    source: 'public';
    parameters: Readonly<{
        policy_visibility: 'public';
    }>;
}> | Readonly<{
    status: 'unavailable';
}>;
/** Nine-axis funded Access preparation bound, including the Access permission transaction. */
export type CollectionAuthorizationPreparation = WorkDimensions & {
    readonly engineRequests: 0;
};
export declare const EMPTY_COLLECTION_AUTHORIZATION_PREPARATION: CollectionAuthorizationPreparation;
export type SpecializeCollectionListInput = Readonly<{
    access: unknown;
    fullView: boolean;
}>;
