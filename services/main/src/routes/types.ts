import { Elysia } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { AccountAssertionDenied } from '../modules/account/verify-assertion.ts';
import {
  ControlConflict,
  ControlDenied,
  ControlInvalid,
  ControlStale,
} from '../modules/access/topology-control.ts';
import {
  typeAdmission,
  typeAdmissionResult,
  typeList,
  typeRetirement,
} from '../modules/types/contract.ts';
import { typeListBody, typeListTag } from '../modules/types/registry.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';

export const openApiOperations = {
  '/v1/types': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false }, post: { exposure: 'platform:platform-admin', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/types/retirements': { post: { exposure: 'platform:platform-admin', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;
function fresh(request: Request): boolean {
  const tags = request.headers.get('if-none-match');
  return (
    !!tags &&
    tags.split(',').some((tag) => [typeListTag, `W/${typeListTag}`, '*'].includes(tag.trim()))
  );
}
function typeError(error: unknown): Response {
  if (error instanceof ControlInvalid) return problem(400, 'invalid_type', error.message);
  if (error instanceof ControlDenied || error instanceof AccountAssertionDenied)
    return problem(403, 'type_admission_denied', 'Type administration requires an admission grant');
  if (error instanceof ControlConflict) return problem(409, 'type_conflict', error.message);
  if (error instanceof ControlStale) return problem(409, 'stale_type', error.message);
  return problem(503, 'types_unavailable', 'Type registry is unavailable');
}

/** Main's request hook refreshes the shared public snapshot before this read. */
export function typeRoutes() {
  return new Elysia().get(
    '/v1/types',
    { response: { 200: typeList, 500: problemResult(500), 503: problemResult(503) } },
    ({ request }) => {
      const headers = { 'cache-control': 'public, max-age=300', etag: typeListTag };
      return fresh(request)
        ? new Response(null, { status: 304, headers })
        : new Response(typeListBody, {
            headers: { ...headers, 'content-type': 'application/json' },
          });
    },
  );
}

export function typeAdministrationRoutes(work: MainWorkDependencies) {
  const write = async (
    request: Request,
    input: { idempotencyKey: string },
    effect: () => Promise<unknown>,
  ) => {
    const key = request.headers.get('idempotency-key');
    if (!key || key !== input.idempotencyKey)
      return problem(400, 'invalid_idempotency_key', 'Idempotency-Key must match the request key');
    if (!work?.types || !work.account) return typeError(undefined);
    try {
      return Response.json(await effect(), { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return typeError(error);
    }
  };
  return new Elysia()
    .post(
      '/v1/types',
      { body: typeAdmission, response: { 200: typeAdmissionResult, ...writeProblems } },
      async ({ request, body }) =>
        write(request, body, async () => {
          const principal = await work!.account.verify(request, ['type:admit']);
          return work!.types!.admit(principal, body);
        }),
    )
    .post(
      '/v1/types/retirements',
      { body: typeRetirement, response: { 200: typeAdmissionResult, ...writeProblems } },
      async ({ request, body }) =>
        write(request, body, async () => {
          const principal = await work!.account.verify(request, ['type:admit']);
          return work!.types!.retire(principal, body);
        }),
    );
}
