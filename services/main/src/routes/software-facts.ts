import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { softwareFacts } from '../modules/software-facts/contract.ts';
import { FactsConflict, FactsTooLarge } from '../modules/game-facts/store.ts';
import { GRAPHS, iri } from '../modules/work/activate.ts';
import { publicWork, workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const id = (uuid: string) => `https://rezics.com/id/${uuid}`;
const actor = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const saved = t.Object({ work: actor, revision: t.Integer({ minimum: 1 }), facts: softwareFacts });
const body = t.Object({ expectedRevision: t.Nullable(t.Integer({ minimum: 1 })),
  actingSubject: actor, facts: softwareFacts }, { additionalProperties: false });
const headers = { 'cache-control': 'no-store' };

export const openApiOperations = {
  '/v1/software-facts/{work}': { get: { bearer: false }, put: { bearer: true, idempotencyKey: true } },
};

async function publicApp(work: MainWorkDependencies, request: Request, target: string): Promise<boolean> {
  return workRead(work, new Request(request.url), {}, async session => {
    const rows = await session.query(`SELECT ?work WHERE {
      BIND(${iri(target)} AS ?work)
      GRAPH ${iri(GRAPHS.current)} { ?work a <https://schema.org/SoftwareApplication> ; rv:mainVersion ?main . }
      ${publicWork('?work', '?main')}
    } LIMIT 2`, 2);
    return rows.length === 1;
  });
}

/** One bounded graph query proves every alternative is another public app. */
async function publicAlternatives(work: MainWorkDependencies, request: Request,
  source: string, targets: readonly string[]): Promise<boolean> {
  if (!targets.length) return true;
  if (new Set(targets).size !== targets.length || targets.includes(source)) return false;
  return workRead(work, new Request(request.url), {}, async session => {
    const rows = await session.query(`SELECT ?work WHERE {
      VALUES ?work { ${targets.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?work a <https://schema.org/SoftwareApplication> ; rv:mainVersion ?main . }
      ${publicWork('?work', '?main')}
    } LIMIT 9`, 9);
    return new Set(rows.map(row => row.work?.value)).size === targets.length;
  });
}

function failure(error: unknown): Response {
  if (error instanceof FactsConflict) return problem(409, 'facts_conflict', error.message);
  if (error instanceof FactsTooLarge) return problem(422, 'facts_budget_exceeded', error.message);
  return commandError(error);
}

/** A public software read is one graph check and one indexed row; no artifact
 * is downloaded or installed by this route. */
export function softwareFactRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/software-facts/:work', { params: t.Object({ work: groupUuid }),
      response: { 200: saved, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.softwareFacts) return problem(503, 'software_facts_unavailable', 'Software facts are unavailable');
        const target = id(params.work);
        if (!await publicApp(work, request, target)) return problem(404, 'work_unavailable', 'App is unavailable');
        const result = await work.softwareFacts.read(target);
        return result ? Response.json(result, { headers }) : problem(404, 'software_facts_missing', 'App facts are not tracked');
      } catch (error) { return failure(error); }
    })
    .put('/v1/software-facts/:work', { params: t.Object({ work: groupUuid }), body,
      response: { 200: saved, 201: saved, ...writeProblems, 422: problemResult(422) },
    }, async ({ request, params, body: input }) => {
      try {
        if (!work.softwareFacts || !work.access.withWorkEditAuthority) {
          return problem(503, 'software_facts_unavailable', 'Software facts are unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
          return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        }
        const target = id(params.work);
        const principal = await work.account.verify(request, ['work:edit']);
        if (!await publicApp(work, request, target)) return problem(404, 'work_unavailable', 'App is unavailable');
        if (input.facts.alternatives.some(item => item.attributedTo !== input.actingSubject)) {
          return problem(422, 'invalid_attribution', 'An alternative must name its acting editor');
        }
        if (!await publicAlternatives(work, request, target, input.facts.alternatives.map(item => item.work))) {
          return problem(422, 'invalid_alternative', 'Alternatives must be distinct public apps');
        }
        const result = await work.access.withWorkEditAuthority(principal, input.actingSubject, target,
          proof => work.softwareFacts!.write(proof.principalId, key, target, input.expectedRevision,
            input.facts, input.actingSubject));
        return Response.json(result, { status: result.revision === 1 ? 201 : 200, headers });
      } catch (error) { return failure(error); }
    });
}
