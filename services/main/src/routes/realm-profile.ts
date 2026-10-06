import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { choosePublicModerator, publishRealmProfile } from '../modules/realm-profile/commands.ts';
import { publicProfile, RealmProfileInvalid, RealmProfileMissing,
  RealmProfileStale, RealmProfileUnavailable } from '../modules/realm-profile/schema.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import { PendingActivation } from '../modules/work/activate.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const position = t.Object({ dataEpoch: t.String(), sequence: t.String() });
const write = t.Object({ realm: readId, revision: readId, receipt: t.String(),
  replayed: t.Boolean(), sourcePosition: position });
const choiceWrite = t.Object({ ...write.properties, agent: readId });
const problems = { ...writeProblems, 404: problemResult(404) };
const id = (value: string) => `https://rezics.com/id/${value}`;
const key = (request: Request) => {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
};

export const openApiOperations = {
  '/v1/realms/{realm}/profile': { put: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/moderators/{agent}/public-choice': {
    put: { exposure: 'public', bearer: true, idempotencyKey: true },
  },
} as const;

function errorResponse(error: unknown): Response {
  if (error instanceof RealmProfileInvalid) return problem(400, 'invalid_realm_profile', error.message);
  if (error instanceof RealmProfileMissing) return problem(404, 'realm_unavailable', 'Realm is unavailable');
  if (error instanceof RealmProfileStale) return Response.json({
    type: 'https://rezics.com/problems/stale_realm_profile', title: error.message,
    status: 409, code: 'stale_realm_profile', currentHead: error.currentHead,
  }, { status: 409, headers: { 'content-type': 'application/problem+json',
    'cache-control': 'no-store' } });
  if (error instanceof RealmProfileUnavailable) return problem(503, 'realm_profile_unavailable',
    'Realm public profile is unavailable');
  if (error instanceof PendingActivation) return problem(503, 'realm_profile_pending', error.message);
  return commandError(error);
}

export function realmProfileRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .put('/v1/realms/:realm/profile', {
      params: t.Object({ realm: readUuid }),
      body: t.Object({ profile: t.Literal('realm-public-profile-v2'),
        expectedHead: t.Nullable(readId), actingSubject: readId,
        publication: publicProfile }, { additionalProperties: false }),
      response: { 200: write, 201: write, ...problems },
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await publishRealmProfile(work.environment, work.media?.store,
          work.account, work.access, request, { realm: id(params.realm),
            expectedHead: body.expectedHead, actingSubject: body.actingSubject,
            profile: body.publication, idempotencyKey }, work.governance?.rules);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return errorResponse(error); }
    })
    .put('/v1/realms/:realm/moderators/:agent/public-choice', {
      params: t.Object({ realm: readUuid, agent: readUuid }),
      body: t.Object({ profile: t.Literal('realm-public-moderator-choice-v1'),
        expectedHead: t.Nullable(readId), public: t.Boolean(), actingSubject: readId },
      { additionalProperties: false }),
      response: { 200: choiceWrite, 201: choiceWrite, ...problems },
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await choosePublicModerator(work.environment, work.account, work.access,
          request, { realm: id(params.realm), agent: id(params.agent),
            expectedHead: body.expectedHead, public: body.public,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return errorResponse(error); }
    });
}
