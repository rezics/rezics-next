/** Library pure core. No Elysia, pg, SQL, Search, Access, Semantic or Content imports. */
export { routeOf } from './route.ts';
export { grantCapable } from './grant.ts';
export { CollectionWorkLedger, WORK_AXES, workAllowance, zeroWorkDimensions } from './work-ledger.ts';
export { ordinaryCollectionPagePlan, ordinaryPageWorkDimensions, type OrdinaryCollectionPagePlan, } from './page-plan.ts';
export { classifySourceOutput, isActivatedPublicAuthority, isPrivateWorkingAuthority, sameSource, } from './source-basis.ts';
export { accountDimensions, admissionTerm, orderedOccurrences, repeatedSubjectCount, sumAdmission, } from './membership-accounting.ts';
export { createIdentityNativeBounds, identityBasisBindValues } from './identity-bounds.ts';
export { admitPublication, classifyPublicationFilter, exactPublicationLocator, type PublicationLocator, } from './publication-admission.ts';
