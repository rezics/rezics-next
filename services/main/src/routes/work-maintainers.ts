import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { readProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const generation = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
const view = t.Object({ work: native, generation, maintainers: t.Array(native, { maxItems: 32 }) });
const result = t.Object({ ...view.properties, receipt: t.String(), replayed: t.Boolean() });
export const openApiOperations = {
  '/v1/work-maintainer-changes': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/works/{id}/maintainers': { get: { exposure: 'public', rateLimitFamily: 'read' } },
} as const;

export function workMaintainerRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/works/:id/maintainers', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: view, ...readProblems, 403: problemResult(403) },
    }, async ({ params }) => {
      try {
        if (!work.maintainers) return problem(503, 'maintainers_unavailable', 'Work maintainers are unavailable');
        return Response.json(await work.maintainers.read(`https://rezics.com/id/${params.id}`),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/work-maintainer-changes', {
      body: t.Object({ profile: t.Literal('work-maintainer-change-v1'), work: native,
        actingSubject: native, target: native, action: t.Union([t.Literal('add'), t.Literal('transfer')]),
        expectedGeneration: generation }, { additionalProperties: false }),
      response: { 200: result, 201: result, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const key = request.headers.get('idempotency-key');
        if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        if (!work.maintainers) return problem(503, 'maintainers_unavailable', 'Work maintainers are unavailable');
        const principal = await work.account.verify(request, ['work:edit']);
        const saved = await work.maintainers.change(principal, body, key);
        return Response.json(saved, { status: saved.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
