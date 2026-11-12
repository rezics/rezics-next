import { KnowledgeReferencesSchema, KnowledgeProvenanceSchema } from './knowledge-portable.ts';
import { t } from 'elysia';

const UUID = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const documentInput = {
  title: t.String({ minLength: 1, maxLength: 512 }),
  language: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 64 }), t.Null()])),
  body: t.Unknown(),
  references: t.Optional(KnowledgeReferencesSchema),
  licence: t.String({ minLength: 1, maxLength: 128 }),
  subjectIds: t.Array(UUID, { maxItems: 64, uniqueItems: true }),
};

export const KnowledgeIdSchema = UUID;
export const KnowledgeNotebookCreateSchema = t.Object(
  { subjectId: UUID, title: t.String({ minLength: 1, maxLength: 256 }) },
  { additionalProperties: false },
);
export const KnowledgeDocumentCreateSchema = t.Object(
  {
    ...documentInput,
    expectedStructureRevisionId: UUID,
    parentPlacementId: t.Union([UUID, t.Null()]),
  },
  { additionalProperties: false },
);
export const KnowledgeDocumentReviseSchema = t.Object(
  { ...documentInput, expectedHeadRevisionId: UUID },
  { additionalProperties: false },
);
export const KnowledgePublicationSchema = t.Object(
  {
    expectedHeadRevisionId: UUID,
    expectedPublicationId: t.Union([UUID, t.Null()]),
    revisionId: t.Union([UUID, t.Null()]),
  },
  { additionalProperties: false },
);
export const KnowledgeExactReadQuerySchema = t.Object(
  { revisionId: t.Optional(UUID) },
  { additionalProperties: false },
);
export const KnowledgePageQuerySchema = t.Object(
  {
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);
export const KnowledgeOutlinePageQuerySchema = t.Object(
  { ...KnowledgePageQuerySchema.properties, parentPlacementId: t.Optional(UUID), revisionId: t.Optional(UUID) },
  { additionalProperties: false },
);
export const KnowledgeDocumentCompareQuerySchema = t.Object(
  { leftRevisionId: UUID, rightRevisionId: UUID },
  { additionalProperties: false },
);
export const KnowledgePlacementMoveSchema = t.Object(
  {
    expectedStructureRevisionId: UUID,
    destinationParentPlacementId: t.Union([UUID, t.Null()]),
    beforePlacementId: t.Union([UUID, t.Null()]),
  },
  { additionalProperties: false },
);

export const KnowledgeCommandResponseSchema = t.Object(
  {
    notebookId: t.Optional(UUID),
    documentId: t.Optional(UUID),
    placementId: t.Optional(UUID),
    structureRevisionId: t.Optional(UUID),
    revisionId: t.Optional(UUID),
    publicationId: t.Optional(t.Union([UUID, t.Null()])),
  },
  { additionalProperties: false },
);
const byteDocument = {
  documentId: UUID,
  revisionId: UUID,
  title: t.String({ minLength: 1, maxLength: 512 }),
  language: t.Union([t.String({ minLength: 1, maxLength: 64 }), t.Null()]),
  references: KnowledgeReferencesSchema,
  provenance: t.Union([KnowledgeProvenanceSchema, t.Null()]),
  canonicalBytes: t.String(),
  sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
  licence: t.String({ minLength: 1, maxLength: 128 }),
  subjectIds: t.Array(UUID, { maxItems: 64 }),
};
export const KnowledgePrivateDocumentSchema = t.Object(
  {
    document: t.Object(
      { ...byteDocument, notebookId: UUID, publicationId: t.Union([UUID, t.Null()]) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const KnowledgePublicDocumentSchema = t.Object(
  {
    document: t.Object(
      {
        ...byteDocument,
        publicationId: UUID,
        subjectId: UUID,
        publishedAt: t.String({ format: 'date-time' }),
        authorId: t.Union([UUID, t.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const nextSchema = t.Union([t.String({ minLength: 1, maxLength: 4096 }), t.Null()]);
const knowledgePosition = t.String({ pattern: '^(?:0|[1-9][0-9]{0,37})$' });
export const KnowledgeOwnedNotebooksSchema = t.Object(
  {
    notebooks: t.Array(
      t.Object(
        {
          notebookId: UUID,
          subjectId: UUID,
          title: t.String({ minLength: 1, maxLength: 256 }),
          structureRevisionId: UUID,
          createdAt: t.String({ format: 'date-time' }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    next: nextSchema,
  },
  { additionalProperties: false },
);
export const KnowledgeOutlineSchema = t.Object(
  {
    notebookId: UUID,
    structureRevisionId: UUID,
    parentPlacementId: t.Union([UUID, t.Null()]),
    placements: t.Array(
      t.Object(
        {
          placementId: UUID,
          documentId: UUID,
          parentPlacementId: t.Union([UUID, t.Null()]),
          position: knowledgePosition,
          title: t.String({ minLength: 1, maxLength: 512 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    next: nextSchema,
  },
  { additionalProperties: false },
);

export const KnowledgeOwnerExportQuerySchema = t.Object({ revisionId: UUID }, { additionalProperties: false });
export const KnowledgeSourceSelectionSchema = t.Union([
  t.Object(
    { representation: t.Literal('public'), documentId: UUID, revisionId: UUID },
    { additionalProperties: false },
  ),
  t.Object(
    { representation: t.Literal('authoring'), accountId: UUID, notebookId: UUID, documentId: UUID, revisionId: UUID },
    { additionalProperties: false },
  ),
]);
export const KnowledgeCopySchema = t.Object(
  {
    source: KnowledgeSourceSelectionSchema,
    expectedStructureRevisionId: UUID,
    parentPlacementId: t.Union([UUID, t.Null()]),
  },
  { additionalProperties: false },
);

const knowledgeHistoryChange = t.Object(
  {
    placementId: UUID,
    action: t.Union([
      t.Literal('placement_added'),
      t.Literal('placement_moved'),
      t.Literal('placement_reordered'),
      t.Literal('order_rebalanced'),
    ]),
    previousParentPlacementId: t.Union([UUID, t.Null()]),
    previousPosition: t.Union([knowledgePosition, t.Null()]),
    parentPlacementId: t.Union([UUID, t.Null()]),
    position: knowledgePosition,
  },
  { additionalProperties: false },
);
export const KnowledgeStructureHistorySchema = t.Object(
  {
    notebookId: UUID,
    revisions: t.Array(
      t.Object(
        {
          structureRevisionId: UUID,
          revisionNumber: t.String({ pattern: '^[1-9][0-9]{0,18}$' }),
          historyAvailable: t.Boolean(),
          changeKind: t.Union([
            t.Literal('legacy'),
            t.Literal('baseline'),
            t.Literal('notebook_created'),
            t.Literal('placement_added'),
            t.Literal('placement_moved'),
            t.Literal('placement_reordered'),
          ]),
          createdAt: t.String({ format: 'date-time' }),
          changes: t.Array(knowledgeHistoryChange, { maxItems: 129 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    next: nextSchema,
  },
  { additionalProperties: false },
);
export const KnowledgeHistoricalOutlineSchema = t.Object(
  {
    notebookId: UUID,
    structureRevisionId: UUID,
    revisionNumber: t.String({ pattern: '^[1-9][0-9]{0,18}$' }),
    parentPlacementId: t.Union([UUID, t.Null()]),
    placements: t.Array(
      t.Object(
        {
          placementId: UUID,
          documentId: UUID,
          parentPlacementId: t.Union([UUID, t.Null()]),
          position: knowledgePosition,
          title: t.String({ minLength: 1, maxLength: 512 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    next: nextSchema,
  },
  { additionalProperties: false },
);
export const KnowledgeDocumentHistorySchema = t.Object(
  {
    documentId: UUID,
    revisions: t.Array(
      t.Object(
        {
          revisionId: UUID,
          title: t.String({ minLength: 1, maxLength: 512 }),
          language: t.Union([t.String({ minLength: 1, maxLength: 64 }), t.Null()]),
          sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
          licence: t.String({ minLength: 1, maxLength: 128 }),
          createdAt: t.String({ format: 'date-time' }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    next: nextSchema,
  },
  { additionalProperties: false },
);
export const KnowledgeDocumentCompareSchema = t.Object(
  {
    documentId: UUID,
    left: t.Object(byteDocument, { additionalProperties: false }),
    right: t.Object(byteDocument, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

const knowledgeGeneration = t.String({ pattern: '^(?:0|[1-9][0-9]{0,18})$' });
export const KnowledgeLifecycleCommandSchema = t.Object(
  { expectedStructureRevisionId: UUID, expectedGeneration: knowledgeGeneration },
  { additionalProperties: false },
);
const lifecycleFields = {
  documentId: UUID,
  notebookId: UUID,
  structureRevisionId: UUID,
  generation: knowledgeGeneration,
  state: t.Union([t.Literal('active'), t.Literal('trashed')]),
  restoreUntil: t.Union([t.String({ format: 'date-time' }), t.Null()]),
};
export const KnowledgeLifecycleSchema = t.Object(lifecycleFields, { additionalProperties: false });
export const KnowledgeLifecycleResultSchema = t.Object(
  { ...lifecycleFields, complete: t.Boolean(), reason: t.Union([t.Literal('subtree_work_required'), t.Null()]) },
  { additionalProperties: false },
);
