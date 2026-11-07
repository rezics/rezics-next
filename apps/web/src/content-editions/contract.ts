import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import * as v from 'valibot';

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
export type EditionSubjectIdentity = v.InferOutput<typeof editionSubjectIdentitySchema>;
export type EditionSourceRecognition = v.InferOutput<typeof sourceIdentitySchema>;
export function parseEditionSourceRecognition(value: unknown): EditionSourceRecognition | null {
  const result = v.safeParse(sourceIdentitySchema, value);
  if (
    !result.success ||
    new Set(result.output.subjects.map((subject) => subject.id)).size !== result.output.subjects.length
  )
    return null;
  return result.output;
}

// Decode the original Content declarations, including their closed field sets.
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

export type EditionMetadata = v.InferOutput<typeof metadataSchema>;
export type EditionRevision = v.InferOutput<typeof revisionSchema>;
export type EditionRead<T> =
  | { state: 'available'; value: T }
  | { state: 'refused'; status: 401 | 403 }
  | { state: 'version-mismatch'; status: 502 }
  | { state: 'unavailable'; status: number; reason: 'native-pending' | 'source' | 'dependency' };

export interface EditionApi {
  /** GET /v1/contentEditions/{id}, with the actual delivery actor's credential. */
  readMetadata(id: string, authorization: string): Promise<EditionRead<EditionMetadata>>;
  /** GET /v1/contentEditions/{id}/revision; native owns final current disclosure. */
  readRevision(id: string, authorization: string): Promise<EditionRead<EditionRevision>>;
}

export function parseEditionMetadata(value: unknown): EditionMetadata | null {
  const result = v.safeParse(metadataSchema, value);
  return result.success &&
    (!result.output.identity || result.output.identity.subject.id === result.output.targetSubjectId)
    ? result.output
    : null;
}
export function parseEditionRevision(value: unknown): EditionRevision | null {
  const result = v.safeParse(revisionSchema, value);
  return result.success ? result.output : null;
}
