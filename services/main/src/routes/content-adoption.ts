import { Elysia, t } from 'elysia';
import type { ResourceReference, ContentSelection } from '../../../content/src/adoption.ts';
import { ContentAdoptionInvalid } from '../../../content/src/adoption.ts';
import { ContentDerivationStale } from '../../../content/src/derivation.ts';
import { documentSnapshotSchema } from '../api-document.ts';
import { readContentDerivations, recordContentDerivation } from '../modules/content-publication/derivation.ts';
import { resolveContentReference } from '../modules/content-publication/reference.ts';
import { workRead, WorkReadLimit } from '../modules/work/read-session.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const closed = { additionalProperties: false };
const variant = t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' });
const contentSelector = t.Object({ grain: t.Literal('content'), variantId: variant, revision: readUuid,
  block: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  span: t.Optional(t.Object({ start: t.Integer({ minimum: 0 }), end: t.Integer({ minimum: 1 }) }, closed)) }, closed);
export const resourceReferenceSchema = t.Unsafe<ResourceReference>(t.Object({ target: t.String({ minLength: 1, maxLength: 2048 }),
  selector: t.Union([t.Object({ grain: t.Literal('resource') }, closed),
    t.Object({ grain: t.Literal('revision'), revision: readId }, closed),
    t.Object({ grain: t.Literal('occurrence'), structure: readId, revision: readId, occurrence: readId }, closed),
    contentSelector, t.Object({ grain: t.Literal('representation'), revision: readUuid, representation: readUuid,
      fragment: t.Optional(t.String({ minLength: 1, maxLength: 100 })) }, closed)]) }, closed));
const output = t.Unsafe<ContentSelection>(t.Object({ target: readId, selector: contentSelector }, closed));
const kind = t.Union(['transcription', 'translation', 'transformation', 'ai-generation'].map(value => t.Literal(value)));
const unavailable = t.Object({ status: t.Literal('unavailable') }, closed);
const record = { derivation: t.String(), output, inputs: t.Array(resourceReferenceSchema, { minItems: 1, maxItems: 16 }),
  activity: t.Object({ id: t.String(), kind }, closed), responsibleAgent: readId,
  responsibleAgentType: t.Union([t.Literal('human'), t.Literal('software')]) };
export const openApiOperations = {
  '/v1/content-derivations': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/content-revisions/{revision}/derivations': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: 'optional' } },
  '/v1/resource-reference-resolutions': { post: { exposure: 'public', rateLimitFamily: 'read', bearer: 'optional' } },
} as const;
const headers = { 'cache-control': 'private, no-store' };
export function contentAdoptionRoutes(deps: MainWorkDependencies) {
  return new Elysia().post('/v1/content-derivations', {
    body: t.Object({ profile: t.Literal('content-derivation-v1'), output,
      inputs: t.Array(resourceReferenceSchema, { minItems: 1, maxItems: 16 }),
      activity: t.Object({ kind }, closed), responsibleAgent: readId,
      expectedOutputHead: readUuid, actingSubject: readId }, closed),
    response: { 200: t.Object({ ...record, replayed: t.Boolean() }),
      201: t.Object({ ...record, replayed: t.Boolean() }), ...workReadProblems },
  }, async ({ request, body }) => {
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
    try {
      const result = await recordContentDerivation(deps, request, body, key);
      return Response.json(result, { status: result.replayed ? 200 : 201, headers });
    } catch (error) {
      if (error instanceof ContentAdoptionInvalid) return problem(400, 'invalid_content_derivation', error.message);
      if (error instanceof ContentDerivationStale) return problem(409, 'stale_head', error.message);
      return commandError(error);
    }
  }).get('/v1/content-revisions/:revision/derivations', {
    params: t.Object({ revision: readUuid }), query: t.Object({ actingSubject: t.Optional(readId),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })), cursor: t.Optional(t.String({ maxLength: 2048 })) }, closed),
    response: { 200: t.Object({ revision: readUuid, items: t.Array(t.Object({ ...record,
      inputs: t.Array(t.Union([resourceReferenceSchema, unavailable]), { maxItems: 16 }),
      responsibleAgent: t.Union([readId, unavailable]), projection: t.Optional(t.Record(t.String(), t.Unknown())) }), { maxItems: 20 }),
      nextCursor: t.Nullable(t.String()), complete: t.Boolean() }), ...workReadProblems },
  }, async ({ request, params, query }) => {
    try { return Response.json(await workRead(deps, request, query, session =>
      readContentDerivations(session, params.revision, query.limit, query.cursor)), { headers }); }
    catch (error) { return workReadError(error); }
  }).post('/v1/resource-reference-resolutions', {
    body: t.Object({ references: t.Array(resourceReferenceSchema, { minItems: 1, maxItems: 16 }),
      actingSubject: t.Optional(readId) }, closed),
    response: { 200: t.Object({ items: t.Array(t.Union([unavailable, t.Object({ status: t.Literal('available'),
      reference: resourceReferenceSchema, projection: t.Record(t.String(), t.Unknown()),
      document: t.Optional(documentSnapshotSchema), text: t.Optional(t.String()) })]), { maxItems: 16 }) }),
      ...workReadProblems },
  }, async ({ request, body }) => {
    try { return Response.json(await workRead(deps, request, { actingSubject: body.actingSubject, readOnlyTemplate: true }, async session => {
      const items = []; for (const reference of body.references) items.push(await resolveContentReference(session, reference));
      if (Buffer.byteLength(JSON.stringify(items), 'utf8') > 1_048_576) throw new WorkReadLimit('Resource reference response exceeds 1 MiB');
      return { items };
    }), { headers }); } catch (error) {
      if (error instanceof ContentAdoptionInvalid) return problem(400, 'invalid_resource_reference', error.message);
      return workReadError(error);
    }
  });
}
