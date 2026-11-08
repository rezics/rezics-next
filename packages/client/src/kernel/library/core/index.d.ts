/** Library pure core. No Elysia, pg, SQL, Search, Access, Semantic or Content imports. */
export { routeOf, partitionOf } from './route.ts';
export { SESSION_LIMITS, boundOf, createProgressOperationBounds, retainSessionOperands, sessionBytesWork, sessionWorkOf, statementWork, } from './progress-operations.ts';
export type { ProgressOperationBounds } from './progress-operations.ts';
export { grantCapable } from './grant.ts';
export { CollectionWorkLedger, WORK_AXES, workAllowance, zeroWorkDimensions } from './work-ledger.ts';
export { ordinaryCollectionPagePlan, ordinaryPageWorkDimensions, type OrdinaryCollectionPagePlan, } from './page-plan.ts';
export { classifySourceOutput, isActivatedPublicAuthority, isPrivateWorkingAuthority, sameSource, } from './source-basis.ts';
export { accountDimensions, admissionTerm, orderedOccurrences, repeatedSubjectCount, sumAdmission, } from './membership-accounting.ts';
export { createIdentityNativeBounds, identityBasisBindValues } from './identity-bounds.ts';
export { admitPublication, classifyPublicationFilter, exactPublicationLocator, type PublicationLocator, } from './publication-admission.ts';
export { followCountScalar, followCountHealthCurrent } from './follow-counts.ts';
export { collectionMetadataChangedFields, collectionMetadataMutationPlan, collectionRetentionDisposition, } from './collection-mutation.ts';
export type { CollectionRetentionHead } from './collection-mutation.ts';
export { createCollectionHistoryPlans, COLLECTION_METADATA_HISTORY_LIMIT, COLLECTION_METADATA_HISTORY_PAGE_SIZE, COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE, } from './collection-history.ts';
export type { CollectionHistoryStatementSizes, CollectionMetadataSnapshotInput, CollectionMetadataFieldInput, } from './collection-history.ts';
export { parseCreate, parseUpdate, parseCopyRestore, subjectId as copySubjectId, vocabularyValue as copyVocabularyValue, revisionValue as copyRevisionValue, parseCopyConditionFields, isCopyConditionValue, CopyConditionInvalidError, } from './copy-input.ts';
export * from './copy-operations.ts';
export { currentLibraryAccount } from './presentation.ts';
