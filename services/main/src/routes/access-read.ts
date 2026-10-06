import { Elysia, t } from 'elysia';
import { authorizedReadProblems } from '../api-responses.ts';
import type { AccessAuthorityRead } from '../modules/access/authority-read.ts';
import { PolicyDenied, PolicyInvalid, PolicyUnavailable } from '../modules/access/policy-errors.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupGeneration, groupUuid } from './shared.ts';

declare module './dependencies.ts' {
  interface MainWorkDependencies { authorityRead?: AccessAuthorityRead }
}

export const openApiOperations = {
  '/v1/access/authority-state': { get: { exposure: 'public', bearer: true } },
  '/v1/access/revocation-sources/{sourceId}': { get: { exposure: 'public', bearer: true } },
} as const;

const scopeId = t.String({ minLength: 1, maxLength: 256 });
const action = t.String({ pattern: '^[a-z][a-z0-9.-]{0,127}$' });
const source = t.Object({ id: groupUuid, generation: groupGeneration });
const noStore = { headers: { 'cache-control': 'private, no-store' } };
const readError = (error: unknown) => {
  if (error instanceof PolicyDenied) return problem(403, 'authority_denied', 'Authority is unavailable');
  if (error instanceof PolicyInvalid) return problem(400, 'invalid_authority_read', error.message);
  if (error instanceof PolicyUnavailable) return problem(503, 'authority_read_unavailable', 'Authority state is unavailable');
  return commandError(error);
};

export function accessReadRoutes(work: MainWorkDependencies) {
  const owner = () => work.authorityRead ?? work.accessPolicy?.authorityRead;
  return new Elysia()
    .get('/v1/access/authority-state', {
      query: t.Object({ scopeId, actingSubject: groupAgent, action }, { additionalProperties: false }),
      response: { 200: t.Object({ profile: t.Literal('access-authority-state-v1'), scopeId,
        actingSubject: groupAgent, action, authorityEpoch: groupGeneration, groupGeneration,
        representation: source, grant: t.Nullable(source) }), ...authorizedReadProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request,
          [query.action === 'access.representation.manage' ? 'access:representation-manage' : 'access:manage']);
        const read = owner();
        if (!read) return problem(503, 'authority_read_unavailable', 'Authority state is unavailable');
        return Response.json({ profile: 'access-authority-state-v1', ...await read.read(principal, query) }, noStore);
      } catch (error) { return readError(error); }
    })
    .get('/v1/access/revocation-sources/:sourceId', {
      params: t.Object({ sourceId: groupUuid }),
      query: t.Object({ issuerSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: t.Object({ profile: t.Literal('access-revocation-source-v1'), scopeId,
        authorityEpoch: groupGeneration, source: t.Object({ ...source.properties, action,
          recipientSubject: groupAgent, active: t.Boolean() }) }), ...authorizedReadProblems },
    }, async ({ request, query, params }) => {
      try {
        const principal = await work.account.verify(request, ['access:manage']);
        const read = owner();
        if (!read) return problem(503, 'authority_read_unavailable', 'Authority state is unavailable');
        return Response.json({ profile: 'access-revocation-source-v1',
          ...await read.revocationSource(principal, { ...query, sourceId: params.sourceId }) }, noStore);
      } catch (error) { return readError(error); }
    });
}
