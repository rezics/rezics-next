import { DocumentSnapshotSchema } from '@rezics/document';
import { BatchReferenceSchema, SourceSchema } from '@rezics/definitions/bulk';
import { t } from 'elysia';
import type { DocumentView } from './document-read.ts';

export type PublicDocumentView =
  | Omit<Extract<DocumentView, { origin: 'import' }>, 'origin'>
  | Extract<DocumentView, { origin: 'account' }>;

export function publicDocument(document: DocumentView): PublicDocumentView {
  if (document.origin === 'account') return document;
  const { origin: _origin, ...imported } = document;
  return imported;
}

const metadata = {
  id: t.String({ format: 'uuid' }),
  subjectId: t.String({ format: 'uuid' }),
  candidateId: t.String({ format: 'uuid' }),
  revision: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  source: t.Object(
    {
      ...SourceSchema.properties,
      field_group: t.Literal('summary'),
      references: t.Array(BatchReferenceSchema, { maxItems: 128 }),
    },
    { additionalProperties: false },
  ),
  rights: t.Object(
    { license: t.String(), obligations: t.Array(t.String()), attribution: t.String() },
    { additionalProperties: false },
  ),
  language: t.String(),
  digest: t.String({ pattern: '^[0-9a-f]{64}$' }),
};
const authoredMetadata = {
  id: metadata.id,
  subjectId: metadata.subjectId,
  candidateId: metadata.candidateId,
  revision: metadata.revision,
  origin: t.Literal('account'),
  author: t.String({ format: 'uuid' }),
  licence: t.String(),
  language: metadata.language,
  digest: metadata.digest,
};

export const PublicDocumentViewSchema = t.Unsafe<PublicDocumentView>(
  t.Union([
    t.Object(
      { ...metadata, availability: t.Literal('available'), body: DocumentSnapshotSchema },
      { additionalProperties: false },
    ),
    t.Object({ ...metadata, availability: t.Literal('erased'), body: t.Null() }, { additionalProperties: false }),
    t.Object(
      { ...authoredMetadata, availability: t.Literal('available'), body: DocumentSnapshotSchema },
      { additionalProperties: false },
    ),
  ]),
);
