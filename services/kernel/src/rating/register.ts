/** Imports owns extraction and licence admission; Web owns presentation. */
export { createOwnVotesReader, OWN_VOTES_PAGE_SIZE } from './own-votes-page.ts';
export type { OwnVoteActions, OwnVoteEntry, OwnVotesPage } from './own-votes-page.ts';
export { OwnVoteActionsSchema, OwnVotesPageSchema, OwnVotesPageQuerySchema } from './own-votes-schemas.ts';
export { createSourceClassificationProducer, SOURCE_CLASSIFICATION_WRITE_ACTION } from './source-classification.ts';
export type {
  SourceClassificationProducer,
  SourceClassificationConfig,
  PutSourceClassification,
  ClearSourceClassification,
  ReadSourceClassificationBatch,
  SourceClassificationMutation,
} from './source-classification.ts';
export {
  ClassificationAssociationSchema,
  ClassificationObservationSchema,
  ClassificationClearSchema,
  classificationAssociationKey,
  classificationObservation,
  classificationDigest,
  classificationQualifiersDigest,
  MAX_SOURCE_CLASSIFICATION_BATCH,
} from './source-classification-contract.ts';
export type {
  ClassificationAssociation,
  ClassificationObservation,
  ClassificationClear,
  SourceClassificationFigure,
  SourceClassificationRead,
} from './source-classification-contract.ts';

export { sourceClassificationRoutes } from './source-classification-routes.ts';
export type { SourceClassificationRouteDependencies } from './source-classification-routes.ts';
export * from './source-classification-http.ts';
