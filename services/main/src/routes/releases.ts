import { Elysia, t } from 'elysia';
import { pendingOperation } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { setRelease } from '../modules/release/command.ts';
import { readWorkRelease, readWorkReleases, readReleasesByIdentifier } from '../modules/release/read.ts';
import { InvalidRelease, ReleaseUnavailable, StaleRelease, releaseWrite, releaseV2Write, releaseV3Write } from '../modules/release/schema.ts';
import { pageFields, pageQuery, readId, readLanguage, readPosition, readUuid } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const headers = { 'cache-control': 'private, no-store' };
const native = `https://rezics.com/id/`;
const kind = t.Union([t.Literal('formal'), t.Literal('web'), t.Literal('fixed'), t.Literal('virtual')]);
const status = t.Union([t.Literal('official'), t.Literal('unofficial'), t.Literal('virtual'),
  t.Literal('withdrawn'), t.Literal('cancelled')]);
const snapshot = t.Object({ id: readId, fetchedAt: t.String(), byteDigest: t.String(), byteLength: t.Integer(),
  coverage: t.Object({ scope: t.String(), complete: t.Boolean() }),
  acquisition: t.Union([t.Literal('fixture'), t.Literal('fetch')]) });
const releaseView = t.Object({ profile: t.Literal('release-v2'), id: readId, revision: readId, kind, status,
  contentLanguages: t.Array(t.String(), { maxItems: 64 }), isTranslation: t.Boolean(),
  originalLanguages: t.Array(t.String(), { maxItems: 4 }), titleLanguage: t.Nullable(t.String()),
  tracklistLanguage: t.Nullable(t.String()), title: t.Object({ value: t.String(), language: t.String() }),
  isbn13: t.Nullable(t.String()), editionStatement: t.Nullable(t.String()),
  publisher: t.Nullable(t.String()), publicationYear: t.Nullable(t.Integer()),
  originalUrl: t.Nullable(t.String()), fixedRelease: t.Nullable(readId),
  identifiers: t.Array(t.Object({ provider: t.String(), value: t.String() }), { maxItems: 16 }),
  platform: t.Nullable(t.String()), territory: t.Nullable(t.String()),
  coverage: t.Array(t.Object({ realization: t.Nullable(readId), revision: t.Nullable(readId),
    work: readId, mainVersion: readId, language: t.Nullable(t.String()),
    completeness: t.Union([t.Literal('complete'), t.Literal('partial'), t.Literal('trial'), t.Literal('unknown')]),
    portion: t.Optional(t.String()) }), { maxItems: 64 }),
  legacyCoverage: t.Nullable(t.Object({ scope: t.String(), complete: t.Boolean() })),
  snapshots: t.Array(snapshot, { maxItems: 20 }) });
const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
export const openApiOperations = {
  '/v1/releases': { get: { bearer: false } },
  '/v1/works/{id}/releases': { get: { bearer: false } },
  '/v1/works/{id}/releases/{release}': { get: { bearer: false }, put: { bearer: true, idempotencyKey: true } },
} as const;

function releaseError(error: unknown) {
  if (error instanceof InvalidRelease) return problem(400, 'invalid_release', error.message);
  if (error instanceof StaleRelease) return problem(409, 'release_basis_changed', 'Refresh the release and retry with a new key');
  if (error instanceof ReleaseUnavailable) return problem(503, 'release_unavailable', 'Release is unavailable');
  return workReadError(error);
}

function keyOf(request: Request): string | Response {
  const key = request.headers.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
    return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
  }
  return key;
}

export function releaseRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/releases', { detail,
      query: t.Object({ ...pageQuery, isbn13: t.Optional(t.String({ maxLength: 13 })),
        provider: t.Optional(t.String({ maxLength: 248 })), identifier: t.Optional(t.String({ maxLength: 200 })) },
        { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(releaseView, { maxItems: 20 }), ...pageFields }), ...workReadProblems },
    }, async ({ request, query: options }) => {
      try { return Response.json(await workRead(work, request, options, session => readReleasesByIdentifier(session, options)), { headers }); }
      catch (error) { return releaseError(error); }
    })
    .put('/v1/works/:id/releases/:release', { params: t.Object({ id: readUuid, release: readUuid }),
      body: t.Union([releaseWrite, releaseV2Write, releaseV3Write]),
      response: { 200: t.Object({ work: readId, release: readId, revision: readId, receipt: t.String(),
        sourcePosition: readPosition, replayed: t.Boolean() }), 202: pendingOperation, ...writeProblems },
    }, async ({ request, params: path, body }) => {
      const key = keyOf(request);
      if (key instanceof Response) return key;
      const release = native + path.release;
      if (body.id !== release) return problem(400, 'invalid_release', 'Release identity differs from its path');
      try { return Response.json(await setRelease(work, request, { ...body, work: native + path.id, idempotencyKey: key }), { headers }); }
      catch (error) { return releaseError(error); }
    })
    .get('/v1/works/:id/releases/:release', { params: t.Object({ id: readUuid, release: readUuid }), detail,
      query: t.Object({ language: t.Optional(readLanguage), actingSubject: t.Optional(readId) }, { additionalProperties: false }),
      response: { 200: t.Object({ ...releaseView.properties, sourcePosition: readPosition }), ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options, session => readWorkRelease(session,
        native + path.id, native + path.release)), { headers }); }
      catch (error) { return releaseError(error); }
    })
    .get('/v1/works/:id/releases', { params: t.Object({ id: readUuid }), detail,
      query: t.Object({ ...pageQuery, contentLanguage: t.Optional(readLanguage) }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(releaseView, { maxItems: 20 }), ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options, session => readWorkReleases(session,
        native + path.id, options.contentLanguage)), { headers }); }
      catch (error) { return releaseError(error); }
    });
}
