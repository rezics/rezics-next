import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import * as v from 'valibot';

const text = v.pipe(v.string(), v.minLength(1));
const digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

// Assigned wire only. Replace with generated exports when native delivery lands.
const metadataSchema = v.strictObject({
  editionId: text,
  editionRevision: text,
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
  body: v.custom<DocumentSnapshot>(checkDocument),
});

export type EditionMetadata = v.InferOutput<typeof metadataSchema>;
export type EditionRevision = v.InferOutput<typeof revisionSchema>;
export type EditionRead<T> =
  | { state: 'available'; value: T }
  | { state: 'refused'; status: 401 | 403 }
  | { state: 'unavailable'; status: number; reason: 'native-pending' | 'source' | 'dependency' };

export interface EditionApi {
  /** GET /v1/contentEditions/{id}, with the actual delivery actor's credential. */
  readMetadata(id: string, authorization: string): Promise<EditionRead<EditionMetadata>>;
  /** GET /v1/contentEditions/{id}/revision; native owns final current disclosure. */
  readRevision(id: string, authorization: string): Promise<EditionRead<EditionRevision>>;
}

export function parseEditionMetadata(value: unknown): EditionMetadata | null {
  const result = v.safeParse(metadataSchema, value);
  return result.success ? result.output : null;
}
export function parseEditionRevision(value: unknown): EditionRevision | null {
  const result = v.safeParse(revisionSchema, value);
  return result.success ? result.output : null;
}

/** No generated native producer exists in this checkout. Never call a public post or a development fake instead. */
export const nativeEditionApi: EditionApi = {
  async readMetadata() {
    return { state: 'unavailable', status: 503, reason: 'native-pending' };
  },
  async readRevision() {
    return { state: 'unavailable', status: 503, reason: 'native-pending' };
  },
};
