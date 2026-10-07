import { Elysia, t } from 'elysia';
import { pendingOperation } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { setWebSnapshot } from '../modules/web-publication/command.ts';
import { snapshotWrite, InvalidWebSnapshot, SnapshotNotFound, SnapshotRightsDenied, SnapshotRobotsDenied,
  WebSnapshotUnavailable } from '../modules/web-publication/schema.ts';
import { readId, readPosition, readUuid } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const headers = { 'cache-control': 'private, no-store' };
const native = 'https://rezics.com/id/';
export const openApiOperations = {
  '/v1/works/{id}/web-publications/{release}/snapshots': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;

function snapshotError(error: unknown) {
  if (error instanceof InvalidWebSnapshot) return problem(400, 'invalid_web_snapshot', error.message);
  if (error instanceof SnapshotNotFound) return problem(404, 'web_publication_not_found', 'Web publication is unavailable');
  if (error instanceof SnapshotRobotsDenied) return problem(403, 'robots_denied', error.message);
  if (error instanceof SnapshotRightsDenied) return problem(403, 'rights_denied', error.message);
  if (error instanceof WebSnapshotUnavailable) return problem(503, 'web_snapshot_unavailable', 'Web snapshot is unavailable');
  return commandError(error);
}

export function webPublicationRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/works/:id/web-publications/:release/snapshots', {
      params: t.Object({ id: readUuid, release: readUuid }), body: snapshotWrite,
      response: { 200: t.Object({ id: readId, publication: readId, work: readId,
        acquisition: t.Union([t.Literal('fixture'), t.Literal('fetch')]), fetchedAt: t.String(),
        byteDigest: t.String(), byteLength: t.Integer(), mediaType: t.String(),
        coverage: t.Object({ scope: t.String(), complete: t.Boolean() }),
        receipt: t.String(), sourcePosition: readPosition, replayed: t.Boolean() }),
        202: pendingOperation, ...writeProblems },
    }, async ({ request, params: path, body }) => {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try { return Response.json(await setWebSnapshot(work, request, { work: native + path.id,
        publication: native + path.release, idempotencyKey: key, body,
        rightsPermitted: origin => work.webSnapshotRetention?.(origin) ?? Promise.resolve(false) }), { headers }); }
      catch (error) { return snapshotError(error); }
    });
}
