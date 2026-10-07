import { Elysia, t } from 'elysia';
import { pageQuery, readId, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadMoved,
  WorkReadUnavailable, workRead } from '../modules/work/read-session.ts';
import { realmDecisionRead, realmDecisionsPage, realmHeader, realmJoinPage, realmWorksPage, realmZoneRead }
  from '../modules/realm-reads/read-contract.ts';
import { readRealmHeader, readRealmLanding } from '../modules/realm-reads/read-realm.ts';
import { readRealmZone } from '../modules/realm-reads/read-zone.ts';
import { readRealmWorks } from '../modules/realm-reads/read-works.ts';
import { readRealmDecision, readRealmDecisions } from '../modules/realm-reads/public-decision-index.ts';
import { readRealmPolicy } from '../modules/space/policy.ts';
import { pageDiscoveryHeaders, pageDiscoveryPolicy } from '../modules/space/visibility.ts';
import type { ReadOptions, WorkReadSession } from '../modules/work/read-session.ts';
import { RealmProfileUnavailable } from '../modules/realm-profile/schema.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { workReadProblems } from './work-reads.ts';

const params = t.Object({ realm: readUuid });
const headers = { 'cache-control': 'no-store' };
const page = t.Object({ actingSubject: t.Optional(readId), limit: pageQuery.limit, cursor: pageQuery.cursor }, { additionalProperties: false });
const id = (uuid: string) => `https://rezics.com/id/${uuid}`;
function realmReadError(error: unknown): Response {
  if (error instanceof WorkReadInvalid) return problem(400, 'invalid_realm_read', error.message);
  if (error instanceof WorkReadMissing) return problem(404, 'realm_unavailable', 'Realm is unavailable');
  if (error instanceof WorkReadMoved) return problem(409, 'read_basis_changed', 'Restart from the first page');
  if (error instanceof WorkReadLimit) return problem(422, 'realm_read_budget_exceeded', 'Realm read exceeds its budget');
  if (error instanceof WorkReadUnavailable) return problem(503, 'realm_read_unavailable', 'Realm read is unavailable');
  if (error instanceof RealmProfileUnavailable) return problem(503, 'realm_read_unavailable',
    'Realm public profile is unavailable');
  return commandError(error);
}

// Anonymous public reads; private Realms require a live approved membership.
export const openApiOperations = {
  '/v1/realms/{realm}/join-page': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/works': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/decisions': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/decisions/{decision}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/realms/{realm}/zone': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
} as const;

export function realmReadRoutes(work: MainWorkDependencies) {
  const read = async (request: Request, options: ReadOptions, realm: string,
    operation: (session: WorkReadSession) => Promise<unknown>) => {
    const result = await workRead(work, request, options, async session => {
      const value = await operation(session);
      // Header and join-page hydrators already carry their final live policy.
      // Reuse it, preserving the profile's measured graph-call envelope.
      if (value && typeof value === 'object' && 'discovery' in value && value.discovery) {
        return { value, discovery: value.discovery as ReturnType<typeof pageDiscoveryPolicy> };
      }
      const policy = await readRealmPolicy(work.environment, realm);
      if (!policy) throw new WorkReadMissing('Realm is unavailable');
      return { value, discovery: pageDiscoveryPolicy(policy.visibility === 'private' ? 'private' : 'public', policy.listing) };
    });
    return Response.json(result.value, { headers: { ...headers,
      ...pageDiscoveryHeaders(result.discovery) } });
  };
  return new Elysia()
    .get('/v1/realms/:realm/join-page', { params,
      query: t.Object({ language: t.Optional(readLanguage), languages: t.Optional(t.String({ maxLength: 720 })) }, { additionalProperties: false }),
      response: { 200: realmJoinPage, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return await read(request, query, id(path.realm), async session => {
        const value = await readRealmLanding(session, id(path.realm));
        if (value.profile !== 'realm-join-page-v1') throw new WorkReadMissing('Realm is unavailable');
        return value;
      }); } catch (error) { return realmReadError(error); }
    })
    .get('/v1/realms/:realm', {
      params, query: t.Object({ actingSubject: t.Optional(readId), language: t.Optional(readLanguage),
        languages: t.Optional(t.String({ maxLength: 720 })) }, { additionalProperties: false }),
      response: { 200: realmHeader, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return await read(request, query, id(path.realm),
        session => readRealmHeader(session, id(path.realm))); }
      catch (error) { return realmReadError(error); }
    })
    .get('/v1/realms/:realm/zone', {
      params, query: t.Object({ actingSubject: t.Optional(readId) }, { additionalProperties: false }),
      response: { 200: realmZoneRead, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return await read(request, query, id(path.realm),
        session => readRealmZone(session, id(path.realm))); }
      catch (error) { return realmReadError(error); }
    })
    .get('/v1/realms/:realm/works', {
      params, query: t.Object({ ...page.properties, language: t.Optional(readLanguage) },
        { additionalProperties: false }),
      response: { 200: realmWorksPage, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return await read(request, query, id(path.realm),
        session => readRealmWorks(session, id(path.realm))); }
      catch (error) { return realmReadError(error); }
    })
    .get('/v1/realms/:realm/decisions', { params, query: page,
      response: { 200: realmDecisionsPage, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return await read(request, query, id(path.realm),
        session => readRealmDecisions(session, id(path.realm))); }
      catch (error) { return realmReadError(error); }
    })
    .get('/v1/realms/:realm/decisions/:decision', {
      params: t.Object({ realm: readUuid, decision: readUuid }),
      query: t.Object({ actingSubject: t.Optional(readId) }, { additionalProperties: false }),
      response: { 200: realmDecisionRead, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return await read(request, query, id(path.realm),
        session => readRealmDecision(session, id(path.realm), id(path.decision))); }
      catch (error) { return realmReadError(error); }
    });
}
