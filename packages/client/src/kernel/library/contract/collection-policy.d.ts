/** Library-owned Collection list residual and authorization-preparation shapes. */
import type { WorkDimensions } from './work-dimensions.ts';
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
export type CollectionAuthorizationPreparation = WorkDimensions & {
    readonly engineRequests: 0;
};
export const EMPTY_COLLECTION_AUTHORIZATION_PREPARATION: CollectionAuthorizationPreparation;
export type SpecializeCollectionListInput = Readonly<{
    access: unknown;
    fullView: boolean;
}>;
