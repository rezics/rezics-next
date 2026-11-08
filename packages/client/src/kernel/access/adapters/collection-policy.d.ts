/** Producer Collection list policy and funded authorization-preparation adapter.
 * Library consumes these through AuthorizationCapability; this module retains SQL and specializePolicy.
 */
import { type PolicyCatalogue } from '@rezics/access';
import { COLLECTION_AUTHORIZATION_MEMBERSHIPS, type CollectionListPolicyOutcome, type CollectionPolicyPort } from '../contract/collection-policy.ts';
import { bindCollectionListFilter } from '../policy-filter.ts';
import type { CollectionAuthorizationPreparation, CollectionListFilter, SpecializeCollectionListInput } from '../../library/contract/index.ts';
export { bindCollectionListFilter, COLLECTION_AUTHORIZATION_MEMBERSHIPS };
/** Private Collections are visible to their curator alone, including during mutation admission. */
export declare function collectionMutationIsConcealed(input: {
    actorAccountId: string;
    curatorAccountId: string | null;
    visibility: string;
}): boolean;
export declare function specializeCollectionListFromCatalogue(catalogue: PolicyCatalogue | undefined, fullView: boolean): CollectionListPolicyOutcome;
export declare function specializeCollectionList(input: SpecializeCollectionListInput): CollectionListFilter;
/** Funded Access permission-preparation bound. Library adds its Collection authorization row. */
export declare function collectionAuthorizationPreparationWork(): CollectionAuthorizationPreparation;
export declare function createCollectionPolicyPorts(): CollectionPolicyPort;
export declare function createLibraryCollectionPolicyMethods(): Readonly<{
    specializeCollectionList(input: SpecializeCollectionListInput): CollectionListFilter;
    collectionAuthorizationPreparation(): CollectionAuthorizationPreparation;
}>;
