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
  { ...KnowledgePageQuerySchema.properties, parentPlacementId: t.Optional(UUID) },
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
          position: t.String({ pattern: '^(?:0|[1-9][0-9]{0,18})$' }),
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
  t.Object({ representation: t.Literal('public'), documentId: UUID, revisionId: UUID }, { additionalProperties: false }),
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
