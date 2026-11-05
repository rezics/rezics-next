import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { isPlatformClosedError } from '../kernel/platform-closed';

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
  body: v.custom<DocumentSnapshot>(checkDocument),
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

function member(value: unknown, key: string): unknown {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * Isolated adapter for Content's editionRoutes declaration while the installed generated
 * client catches up. Use its real Eden proxy/transport without casting an undelivered
 * client type. Every response crosses the owner's closed decoder before becoming data.
 */
export function createNativeEditionApi(client?: KernelClient): EditionApi {
  async function read<T>(
    id: string,
    authorization: string,
    revision: boolean,
    decode: (value: unknown) => T | null,
  ): Promise<EditionRead<T>> {
    if (!client) return { state: 'unavailable', status: 503, reason: 'native-pending' };
    try {
      // These exact paths and the `id` parameter come from Content's editionRoutes.
      const editions = member(client, 'contentEditions');
      if (typeof editions !== 'function') return { state: 'unavailable', status: 503, reason: 'source' };
      const resource: unknown = Reflect.apply(editions, client, [{ id }]);
      const endpoint = revision ? member(resource, 'revision') : resource;
      const get = member(endpoint, 'get');
      if (typeof get !== 'function') return { state: 'unavailable', status: 503, reason: 'source' };
      const result: unknown = await Reflect.apply(get, endpoint, [
        { headers: { authorization }, fetch: { redirect: 'manual', cache: 'no-store' } },
      ]);
      const status = member(result, 'status');
      if (status === 401 || status === 403) return { state: 'refused', status };
      if (status !== 200 || member(result, 'error'))
        return {
          state: 'unavailable',
          status: typeof status === 'number' && status >= 400 && status <= 599 ? status : 502,
          reason: status === 404 || status === 410 ? 'source' : 'dependency',
        };
      const value = decode(member(result, 'data'));
      return value === null ? { state: 'version-mismatch', status: 502 } : { state: 'available', value };
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'refused', status: 403 };
      return { state: 'unavailable', status: 503, reason: 'dependency' };
    }
  }
  return {
    readMetadata: (id, authorization) => read(id, authorization, false, parseEditionMetadata),
    readRevision: (id, authorization) => read(id, authorization, true, parseEditionRevision),
  };
}

/** Explicit unbound result for callers without native transport. The served reader binds a real client. */
export const nativeEditionApi = createNativeEditionApi();
