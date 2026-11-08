/** Access-owned Collection list request vocabulary and residual outcomes.
 * SQL parameters and directory page plans stay on Library's CollectionListFilter.
 */
export declare const COLLECTION_READ_ACTION = "collection:read";
export declare const COLLECTION_UPDATE_ACTION = "collection:update";
export declare const COLLECTION_RESOURCE_TYPE = "library.collection";
export declare const COLLECTION_AUTHORIZATION_ACTOR_MEMBERS = 2;
export declare const COLLECTION_AUTHORIZATION_GRANT_ROLES = 1;
/** Inclusive inverse-writer slots in the funded collection-update preparation bound. */
export declare const COLLECTION_AUTHORIZATION_MEMBERSHIPS = 1000;
export declare const COLLECTION_PUBLIC_FLOOR_OPERAND: 'public.floor';
export type CollectionListResourceOperand = typeof COLLECTION_PUBLIC_FLOOR_OPERAND;
/** Two actor memberships (account and requested-by) against the native inverse writer limit. */
export type CollectionListPolicyMode = 'ordinary';
export type CollectionListPolicyRequest = Readonly<{
    action: typeof COLLECTION_READ_ACTION;
    resourceType: typeof COLLECTION_RESOURCE_TYPE;
    mode: CollectionListPolicyMode;
    authenticatedBenefit: false;
    anonymous: boolean;
    hasPrincipal: false;
}>;
export type CollectionListPolicySubjectFacts = Readonly<{
    actionGrant: boolean;
    resourceRoleGrant: boolean;
    ownAccount: boolean;
    authenticatedBenefit: boolean;
}>;
export type CollectionListPolicyFacts = Readonly<{
    standing: true;
    assignment: true;
    deadlineLive: true;
    scope: boolean;
    localDenial: false;
    publicFloor?: false;
    actor: CollectionListPolicySubjectFacts;
}>;
/** Residual interpretation before Library binds its indexed SQL parameters. */
export type CollectionListPolicyOutcome = Readonly<{
    status: 'ready';
    source: 'curator';
}> | Readonly<{
    status: 'ready';
    source: 'public';
}> | Readonly<{
    status: 'unavailable';
}>;
export type CollectionPolicyPort = {
    catalogueFor(access: unknown): unknown;
    specializeFromCatalogue(catalogue: unknown, fullView: boolean): CollectionListPolicyOutcome;
    authorizationPreparation(): import('./bounds.ts').AccessWorkDimensions;
};
