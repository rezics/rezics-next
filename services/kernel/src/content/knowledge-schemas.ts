import { t } from 'elysia';

const UUID = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const documentInput = {
  title: t.String({ minLength: 1, maxLength: 512 }),
  language: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 64 }), t.Null()])),
  body: t.Unknown(),
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
  canonicalBytes: t.String(),
  sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
  licence: t.String({ minLength: 1, maxLength: 128 }),
  subjectIds: t.Array(UUID, { maxItems: 64 }),
};
export const KnowledgePrivateDocumentSchema = t.Object(
  { document: t.Object({ ...byteDocument, notebookId: UUID }, { additionalProperties: false }) },
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
