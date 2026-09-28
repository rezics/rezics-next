import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { gameFacts } from '../modules/game-facts/contract.ts';
import { FactsConflict, FactsTooLarge } from '../modules/game-facts/store.ts';
import { GRAPHS, iri } from '../modules/work/activate.ts';
import { publicWork, workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const id = (uuid: string) => `https://rezics.com/id/${uuid}`;
const actor = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const saved = t.Object({ work: actor, revision: t.Integer({ minimum: 1 }), facts: gameFacts });
const body = t.Object({ expectedRevision: t.Nullable(t.Integer({ minimum: 1 })),
  actingSubject: actor, facts: gameFacts }, { additionalProperties: false });
const headers = { 'cache-control': 'no-store' };

export const openApiOperations = {
  '/v1/game-facts/{work}': { get: { bearer: false }, put: { bearer: true, idempotencyKey: true } },
};

async function publicGame(work: MainWorkDependencies, request: Request, target: string): Promise<boolean> {
  return workRead(work, new Request(request.url), {}, async session => {
    const rows = await session.query(`SELECT ?work WHERE {
      BIND(${iri(target)} AS ?work)
      GRAPH ${iri(GRAPHS.current)} { ?work a <https://schema.org/VideoGame> ; rv:mainVersion ?main . }
      ${publicWork('?work', '?main')}
    } LIMIT 2`, 2);
    return rows.length === 1;
  });
}

function failure(error: unknown): Response {
  if (error instanceof FactsConflict) return problem(409, 'facts_conflict', error.message);
  if (error instanceof FactsTooLarge) return problem(422, 'facts_budget_exceeded', error.message);
  return commandError(error);
}

/** Public read: one graph authorization check and one indexed Access row.
 * Edit: Work authority, one bounded record and a revisioned receipt. */
export function gameFactRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/game-facts/:work', { params: t.Object({ work: groupUuid }),
      response: { 200: saved, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.gameFacts) return problem(503, 'game_facts_unavailable', 'Game facts are unavailable');
        const target = id(params.work);
        if (!await publicGame(work, request, target)) return problem(404, 'work_unavailable', 'Game is unavailable');
        const result = await work.gameFacts.read(target);
        return result ? Response.json(result, { headers }) : problem(404, 'game_facts_missing', 'Game facts are not tracked');
      } catch (error) { return failure(error); }
    })
    .put('/v1/game-facts/:work', { params: t.Object({ work: groupUuid }), body,
      response: { 200: saved, 201: saved, ...writeProblems, 422: problemResult(422) },
    }, async ({ request, params, body: input }) => {
      try {
        if (!work.gameFacts || !work.access.withWorkEditAuthority) {
          return problem(503, 'game_facts_unavailable', 'Game facts are unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
          return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        }
        const target = id(params.work);
        const principal = await work.account.verify(request, ['work:edit']);
        if (!await publicGame(work, request, target)) return problem(404, 'work_unavailable', 'Game is unavailable');
        const result = await work.access.withWorkEditAuthority(principal, input.actingSubject, target,
          proof => work.gameFacts!.write(proof.principalId, key, target, input.expectedRevision,
            input.facts, input.actingSubject));
        return Response.json(result, { status: result.revision === 1 ? 201 : 200, headers });
      } catch (error) { return failure(error); }
    });
}
