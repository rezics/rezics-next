import { Elysia, t } from 'elysia';
import type { Static } from 'typebox';
import { problemResult } from '../api-contract.ts';
import { ControlConflict, ControlDenied, ControlInvalid, ControlStale, ControlUnavailable }
  from '../modules/access/topology-control.ts';
import { DEFAULT_PERSON_CHOICES } from '../modules/preferences/store.ts';
import { readingLanguages } from '../modules/preferences/languages.ts';
import { readId } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const noStore = { 'cache-control': 'private, no-store' };
const visibility = t.Union([t.Literal('public'), t.Literal('private')]);
const followPolicy = t.Union([t.Literal('everyone'), t.Literal('nobody')]);
const spoilerPolicy = t.Union([t.Literal('hide-unread'), t.Literal('show')]);
const settings = t.Object({ profileVisibility: visibility, followPolicy, hideReadingActivity: t.Boolean(),
  contentLanguages: readingLanguages, spoilerPolicy, adultContent: t.Boolean() },
{ additionalProperties: false });
const result = t.Object({ profile: t.Literal('person-preferences-v1'), ...settings.properties,
  version: t.Integer({ minimum: 0 }), blockedPeople: t.Array(readId, { maxItems: 500 }),
  replayed: t.Optional(t.Boolean()) });
const blockResult = t.Object({ target: readId, blocked: t.Boolean(), replayed: t.Boolean() });
const blockTarget = t.Union([readId, t.String({ pattern: '^@[a-z0-9_]{3,30}$' })]);
const errors = { 400: problemResult(400), 401: problemResult(401),
  403: problemResult(403), 409: problemResult(409), 503: problemResult(503) };
type Command = Static<typeof settings> & { actingSubject: string; expectedVersion: number };
type BlockCommand = { actingSubject: string; target: string; blocked: boolean };

export const openApiOperations = {
  '/v1/me/person-preferences': { get: { bearer: true }, put: { bearer: true, idempotencyKey: true } },
  '/v1/me/blocked-people': { put: { bearer: true, idempotencyKey: true } },
} as const;

function failure(error: unknown): Response {
  if (error instanceof ControlInvalid) return problem(400, 'invalid_person_preferences', error.message);
  if (error instanceof ControlDenied) return problem(403, 'person_preferences_denied', error.message);
  if (error instanceof ControlStale || error instanceof ControlConflict) {
    return problem(409, 'person_preferences_conflict', error.message);
  }
  if (error instanceof ControlUnavailable) return problem(503, 'person_preferences_unavailable', error.message);
  return commandError(error);
}

export function preferencesRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/me/person-preferences', { query: t.Object({ actingSubject: readId }, { additionalProperties: false }),
      response: { 200: result, ...errors } }, async ({ request, query }: { request: Request;
        query: { actingSubject: string } }) => {
      if (!work.personPreferences) return problem(503, 'person_preferences_unavailable', 'Preferences are unavailable');
      try {
        const principal = await work.account.verify(request, ['follow:read']);
        return Response.json(await work.personPreferences.read(principal, query.actingSubject), { headers: noStore });
      } catch (error) { return failure(error); }
    })
    .put('/v1/me/person-preferences', { body: t.Object({ actingSubject: readId,
      expectedVersion: t.Integer({ minimum: 0 }), ...settings.properties }, { additionalProperties: false }),
      response: { 200: result, ...errors } }, async ({ request, body }: { request: Request; body: Command }) => {
      if (!work.personPreferences) return problem(503, 'person_preferences_unavailable', 'Preferences are unavailable');
      try {
        const principal = await work.account.verify(request, ['follow:write']);
        const { actingSubject, expectedVersion, ...value } = body;
        return Response.json(await work.personPreferences.write(principal, actingSubject,
          { ...DEFAULT_PERSON_CHOICES, ...value }, expectedVersion,
          request.headers.get('idempotency-key') ?? ''), { headers: noStore });
      } catch (error) { return failure(error); }
    })
    .put('/v1/me/blocked-people', { body: t.Object({ actingSubject: readId, target: blockTarget,
      blocked: t.Boolean() }, { additionalProperties: false }),
      response: { 200: blockResult, ...errors } }, async ({ request, body }: { request: Request;
        body: BlockCommand }) => {
      if (!work.personPreferences) return problem(503, 'person_preferences_unavailable', 'Preferences are unavailable');
      try {
        const principal = await work.account.verify(request, ['follow:write']);
        return Response.json(await work.personPreferences.block(principal, body.actingSubject, body.target,
          body.blocked, request.headers.get('idempotency-key') ?? ''), { headers: noStore });
      } catch (error) { return failure(error); }
    });
}
