/** Imports and Web use this producer directly in their existing server composition.
 * Imports owns extraction and licence admission; Web owns all presentation and routes.
 */
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
