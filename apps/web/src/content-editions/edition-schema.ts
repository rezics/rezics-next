import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import * as v from 'valibot';
import type { EditionMetadata, EditionRevision, EditionSourceRecognition } from './contract';

const text = v.pipe(v.string(), v.minLength(1));
const digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

export const editionSubjectIdentitySchema = v.variant('kind', [
  v.strictObject({ id: text, kind: v.literal('available'), label: v.strictObject({ value: text, language: text }) }),
  v.strictObject({ id: text, kind: v.literal('missing'), label: v.null() }),
  v.strictObject({ id: text, kind: v.literal('withheld'), label: v.null() }),
]);
const revisionDate = v.nullable(v.pipe(v.string(), v.isoTimestamp()));
const editionIdentitySchema = v.strictObject({
  subject: editionSubjectIdentitySchema,
  revisionCreatedAt: revisionDate,
});
const sourceIdentitySchema = v.strictObject({
  postId: text,
  revisionId: text,
  sha256: digest,
  revisionCreatedAt: revisionDate,
  subjects: v.pipe(v.array(editionSubjectIdentitySchema), v.maxLength(128)),
});
const metadataSchema = v.strictObject({
  editionId: text,
  editionRevision: text,
  identity: v.optional(editionIdentitySchema),
  state: v.picklist(['draft', 'published', 'withdrawn']),
  targetSubjectId: text,
  creatorAccountId: text,
  revisionId: text,
  sha256: digest,
  licence: text,
});
const revisionSchema = v.strictObject({
  editionId: text,
  revisionId: text,
  sha256: digest,
  licence: text,
  body: v.custom<DocumentSnapshot>((value) => checkDocument(value)),
});

export function parseEditionSourceRecognition(value: unknown): EditionSourceRecognition | null {
  const result = v.safeParse(sourceIdentitySchema, value);
  if (
    !result.success ||
    new Set(result.output.subjects.map((subject) => subject.id)).size !== result.output.subjects.length
  )
    return null;
  return result.output as EditionSourceRecognition;
}

export function parseEditionMetadata(value: unknown): EditionMetadata | null {
  const result = v.safeParse(metadataSchema, value);
  return result.success &&
    (!result.output.identity || result.output.identity.subject.id === result.output.targetSubjectId)
    ? (result.output as EditionMetadata)
    : null;
}

export function parseEditionRevision(value: unknown): EditionRevision | null {
  const result = v.safeParse(revisionSchema, value);
  return result.success ? (result.output as EditionRevision) : null;
}
