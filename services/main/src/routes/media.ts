import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../infrastructure/immutable-objects.ts';
import { activateUploadedBytes, changeAdmittedAssetState, MediaDenied, reserveAdmittedUpload,
  saveAdmittedMediaSet, type MediaDependencies } from '../modules/media/commands.ts';
import { MAX_UPLOAD_BYTES, MediaConflict, MediaFenced, MediaInvalid, MediaMissing, MediaStale,
  MediaUnavailable, avatarImageEligible } from '../modules/media/store.ts';
import { readResourceSummaries } from '../modules/media/summary.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

declare module './dependencies.ts' {
  interface MainWorkDependencies {
    /** Media owner; absent media routes answer 503. */
    media?: MediaDependencies;
  }
}

const nativeId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const position = t.Object({ owner: t.Literal('content'), dataEpoch: t.String(), sequence: t.String() });
const commandResult = t.Object({ outcome: t.String(), id: t.Nullable(t.String()),
  predecessor: t.Nullable(t.String()), position, replayed: t.Boolean(), admission: t.String() });

/** Media errors first; everything else keeps the shared command mapping. */
export function mediaError(error: unknown): Response {
  if (error instanceof MediaInvalid) return problem(400, 'invalid_media_request', 'Media request is invalid');
  if (error instanceof MediaDenied || error instanceof MediaFenced) return problem(403, 'authority_denied', 'Authority is not admitted');
  if (error instanceof MediaMissing) return problem(404, 'media_unavailable', 'Media is unavailable');
  if (error instanceof MediaConflict) return problem(409, 'idempotency_conflict', 'Operation key binds another intent');
  if (error instanceof MediaStale) return problem(409, 'stale_head', 'Media head or reservation changed');
  if (error instanceof MediaUnavailable || error instanceof ObjectUnavailable
    || error instanceof ObjectIntegrityError) {
    return problem(503, 'media_unavailable', 'Media owner is unavailable');
  }
  return commandError(error);
}

function idempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  return key && /^[A-Za-z0-9:_./-]{1,128}$/.test(key) ? key : null;
}

const unavailable = () => problem(404, 'media_unavailable', 'Media is unavailable');

/** Serve one exact representation after the caller-independent disclosure checks. */
async function deliver(media: MediaDependencies, basis: { objectNamespace: string; sha256: string;
  mediaType: string }, publicTarget: boolean): Promise<Response> {
  const bytes = await media.objects(basis.objectNamespace).get(basis.sha256);
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': basis.mediaType,
    etag: `"${basis.sha256}"`, 'x-content-type-options': 'nosniff',
    // Revalidation keeps shared caches from outliving a revoked selection or disclosure.
    'cache-control': publicTarget ? 'public, no-cache' : 'private, no-store' } });
}

export function mediaRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const readerFor = async (request: Request, actingSubject: string | undefined) => {
    if (!request.headers.get('authorization')) return {};
    if (!actingSubject) throw new MediaInvalid('actingSubject is required for an authenticated read');
    const principal = await work.account.verify(request, ['work:read']);
    return { canReadWork: (resource: string) => work.access.canReadWork(principal, actingSubject, resource) };
  };
  return new Elysia()
    .post('/v1/media/uploads', {
      body: t.Object({ profile: t.Literal('media-image-upload-v1'), asset: t.Nullable(uuid),
        mediaType: t.Union([t.Literal('image/png'), t.Literal('image/jpeg'), t.Literal('image/webp'),
          t.Literal('image/gif')]),
        byteLength: t.Integer({ minimum: 1, maximum: MAX_UPLOAD_BYTES }),
        sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
        disclosure: t.Union([t.Literal('private'), t.Literal('public')]),
        actingSubject: nativeId }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), 201: t.Object({}, { additionalProperties: true }), ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const { profile: _profile, ...input } = body;
        const reserved = await reserveAdmittedUpload(work.environment, work.media, work.account, work.access,
          request, { ...input, idempotencyKey: key });
        return Response.json({ ...reserved, uploadUrl: `/v1/media/uploads/${reserved.upload}/bytes` },
          { status: reserved.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .put('/v1/media/uploads/:upload/bytes', {
      params: t.Object({ upload: uuid }),
      parse: 'none',
      response: { 200: t.Object({}, { additionalProperties: true }), 201: t.Object({}, { additionalProperties: true }), ...writeProblems, 404: problemResult(404),
        413: problemResult(413), 422: problemResult(422) },
    }, async ({ request, params }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const declared = Number(request.headers.get('content-length') ?? '0');
      if (declared > MAX_UPLOAD_BYTES) return problem(413, 'media_too_large', 'Upload exceeds the admitted size');
      try {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > MAX_UPLOAD_BYTES) return problem(413, 'media_too_large', 'Upload exceeds the admitted size');
        const result = await activateUploadedBytes(work.environment, work.media, work.account, work.access,
          request, params.upload, bytes);
        if (result.status === 'rejected') {
          return Response.json({ ...result }, { status: 422, headers: { 'cache-control': 'no-store' } });
        }
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .post('/v1/media/assets/:asset/state', {
      params: t.Object({ asset: uuid }),
      body: t.Object({ profile: t.Literal('media-asset-state-v1'), expectedState: uuid,
        disclosure: t.Union([t.Literal('private'), t.Literal('public')]),
        lifecycle: t.Union([t.Literal('active'), t.Literal('deleted'), t.Literal('erased')]),
        actingSubject: nativeId }, { additionalProperties: false }),
      response: { 200: commandResult, 201: commandResult, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const result = await changeAdmittedAssetState(work.environment, work.media, work.account, work.access,
          request, { asset: params.asset, expectedState: body.expectedState, disclosure: body.disclosure,
            lifecycle: body.lifecycle, actingSubject: body.actingSubject, idempotencyKey: key });
        if (result.outcome === 'stale_head') {
          return Response.json({ type: 'https://rezics.com/problems/stale_head', title: 'Asset state changed',
            status: 409, code: 'stale_head', current: result.predecessor, replayed: result.replayed },
          { status: 409, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
        }
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .post('/v1/media/publications', {
      body: t.Object({ profile: t.Literal('media-set-v1'), resourceId: nativeId,
        variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
        expectedHead: t.Nullable(uuid), assets: t.Array(uuid, { minItems: 1, maxItems: 16 }),
        actingSubject: nativeId }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), 201: t.Object({}, { additionalProperties: true }), ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const saved = await saveAdmittedMediaSet(work.environment, work.media, work.account, work.access,
          request, { resourceId: body.resourceId, variantId: body.variantId, expectedHead: body.expectedHead,
            assets: body.assets, actingSubject: body.actingSubject, idempotencyKey: key });
        return Response.json(saved, { status: saved.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .get('/v1/media/avatars/:selection', {
      params: t.Object({ selection: uuid }),
      query: t.Object({ actingSubject: t.Optional(nativeId) }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const basis = await work.media.store.avatarDelivery(params.selection);
        if (!basis || !avatarImageEligible(basis)) return unavailable();
        const target = (await readResourceSummaries(work.environment, undefined,
          await readerFor(request, query.actingSubject),
          { resources: [basis.target], context: basis.context!, language: null })).summaries[0]!;
        if (target.status !== 'available') return unavailable();
        return await deliver(work.media, { objectNamespace: basis.objectNamespace,
          sha256: basis.sha256!, mediaType: basis.mediaType! }, target.disclosure === 'public');
      } catch (error) { return mediaError(error); }
    })
    .get('/v1/media/uses/:use', {
      params: t.Object({ use: uuid }),
      query: t.Object({ actingSubject: t.Optional(nativeId) }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const item = await work.media.store.itemDelivery(params.use);
        if (!item || item.availability !== 'available' || item.disclosure !== 'public'
          || item.moderation !== 'none' || item.lifecycle !== 'active') return unavailable();
        const target = (await readResourceSummaries(work.environment, undefined,
          await readerFor(request, query.actingSubject),
          { resources: [item.target], context: 'urn:rezics:media:context:default', language: null })).summaries[0]!;
        if (target.status !== 'available') return unavailable();
        return await deliver(work.media, item, target.disclosure === 'public');
      } catch (error) { return mediaError(error); }
    });
}
