import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { HubDependencyInvalid, lowerSkillDependencies } from '../modules/hub/deps.ts';
import { HubUnavailable } from '../modules/hub/store.ts';
import { PackageLockConflict, PackageLockInvalid, PackageLockUnavailable } from '../modules/package/lock.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

export const openApiOperations = {
  '/v1/hub/revisions/{revision}/dependencies': { post: { exposure: 'platform:developer-extras', bearer: true, idempotencyKey: true } },
} as const;

const segment = t.Object({ ecosystem: t.Union([t.Literal('npm'), t.Literal('cargo'), t.Literal('go')]),
  resolution: groupUuid,
  scope: t.Object({ kind: t.Union([t.Literal('process'), t.Literal('path'), t.Literal('abi')]),
    label: t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' }) }, { additionalProperties: false }),
  requirements: t.Array(t.Integer({ minimum: 0, maximum: 255 }), { maxItems: 256 }) },
{ additionalProperties: false });
const bodySchema = t.Object({ profile: t.Literal('hub-dependency-lock-v1'),
  actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
  segments: t.Array(segment, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false });
const lockView = t.Object({ lock: groupUuid, contractVersion: t.Literal('rezics-package-lock-v1'),
  lockSha256: t.String({ pattern: '^[0-9a-f]{64}$' }), manifest: t.Record(t.String(), t.Unknown()),
  createdAt: t.String() });

function errorResponse(error: unknown): Response {
  if (error instanceof HubDependencyInvalid || error instanceof PackageLockInvalid) {
    return problem(422, 'hub_dependency_invalid', error.message);
  }
  if (error instanceof PackageLockConflict) return problem(409, 'package_conflict', error.message);
  if (error instanceof PackageLockUnavailable) return problem(404, 'package_unavailable', error.message);
  if (error instanceof HubUnavailable) return problem(503, 'hub_unavailable', error.message);
  return commandError(error);
}

const json = (value: unknown, status = 200) => Response.json(value,
  { status, headers: { 'cache-control': 'private, no-store' } });

/** Bind exact solved profile receipts to the private exact lock owner. */
export function hubDependencyRoutes(work: MainWorkDependencies) {
  return new Elysia().post('/v1/hub/revisions/:revision/dependencies', {
    params: t.Object({ revision: groupUuid }), body: bodySchema,
    response: { 200: lockView, 201: lockView, ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
  }, async ({ request, params, body }) => {
    try {
      if (!work.hub || !work.packageLocks) {
        return problem(503, 'hub_unavailable', 'Skill dependency owner is unavailable');
      }
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      const principal = await work.account.verify(request, ['work:read', 'package:resolve']);
      const principalId = await work.access.activePrincipalId(principal);
      if (!principalId) return problem(403, 'hub_authority_denied', 'Principal is inactive');
      const resource = await work.hub.skillResource(params.revision);
      if (!resource || !await work.access.canReadWork(principal, body.actingSubject, resource)) {
        return problem(404, 'hub_revision_unavailable', 'Skill revision is unavailable');
      }
      const bindings = await work.hub.skillRequirements(params.revision);
      const plan = lowerSkillDependencies({ ...body, revision: params.revision }, bindings);
      const result = await work.packageLocks.create(principalId, key, plan.request, plan.subject);
      return json(result.lock, result.replayed ? 200 : 201);
    } catch (error) { return errorResponse(error); }
  });
}
