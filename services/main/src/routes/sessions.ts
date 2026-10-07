import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { InvalidSession, SESSION_COST, SessionConflict, SessionDenied, SessionMissing, StaleSession,
  sessionChanges, sessionResult, sessionState, type SelectionInput } from '../modules/session/contract.ts';
import { resolveSessionSelections } from '../modules/session/resolve.ts';
import { TargetNotBound } from '../modules/target/resolve.ts';
import { workRead } from '../modules/work/read-session.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const privateHeaders = { 'cache-control': 'private, no-store' };
const command = { actingSubject: readId, expectedVersion: t.Integer({ minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER - 1 }), ...sessionChanges };
const conflict = t.Object({ ...problemResult(409).properties,
  current: t.Optional(sessionState),
  submitted: t.Optional(t.Object({ expectedVersion: command.expectedVersion, ...sessionChanges })) });
const errors = { ...workReadProblems, 409: conflict };
export const openApiOperations = {
  '/v1/me/sessions': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true }, post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/me/sessions/{id}': { patch: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;

function failure(error: unknown): Response {
  if (error instanceof InvalidSession) return problem(400, 'invalid_session', error.message);
  if (error instanceof SessionDenied) return problem(403, 'session_denied', error.message);
  if (error instanceof SessionMissing) return problem(404, 'session_unavailable', error.message);
  if (error instanceof SessionConflict) return problem(409, 'session_conflict', error.message);
  if (error instanceof TargetNotBound) return problem(422, error.code, error.message);
  if (error instanceof StaleSession) return Response.json({ type: 'https://rezics.com/problems/stale_session',
    title: error.message, status: 409, code: 'stale_session', current: error.current, submitted: error.submitted },
  { status: 409, headers: { ...privateHeaders, 'content-type': 'application/problem+json' } });
  if (error && typeof error === 'object' && 'code' in error
    && ['55P03', '57014', '40P01'].includes(String(error.code))) {
    return problem(503, 'session_unavailable', 'Sessions are busy; retry with the same Idempotency-Key');
  }
  return workReadError(error);
}

export function sessionsRoutes(work: MainWorkDependencies) {
  const own = async (request: Request, agent: string) => {
    const principal = await work.account.verify(request, ['work:read']);
    // Access's own-person baseline excludes delegated Agents, even when they
    // hold work.read, agent.control or another public command's permission.
    if (!await work.access.canReadAsBaselineMember?.(principal, agent)) {
      throw new SessionDenied('Sessions are private to the principal’s own Person');
    }
    return principal;
  };
  return new Elysia()
    .get('/v1/me/sessions', { query: t.Object({ actingSubject: readId,
      target: t.Optional(readId), work: t.Optional(readId), limit: t.Optional(t.Integer({ minimum: 1, maximum: SESSION_COST.page })),
      cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(sessionState, { maxItems: SESSION_COST.page }),
        nextCursor: t.Nullable(t.String()) }), ...errors },
    }, async ({ request, query }) => {
      if (!work.sessions) return problem(503, 'session_unavailable', 'Sessions are unavailable');
      try {
        const principal = await own(request, query.actingSubject);
        const value = await work.sessions.page({ principal, agent: query.actingSubject }, query);
        await own(request, query.actingSubject);
        return Response.json(value, { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .post('/v1/me/sessions', { body: t.Object({ ...command, target: readId }, { additionalProperties: false }),
      response: { 201: sessionResult, ...errors },
    }, async ({ request, body }) => {
      if (!work.sessions) return problem(503, 'session_unavailable', 'Sessions are unavailable');
      try {
        const principal = await own(request, body.actingSubject);
        const { actingSubject, target, expectedVersion, ...changes } = body;
        const additions = changes.addSelections ?? [];
        const inputs: SelectionInput[] = [{ target, ...additions.find(item => item.target === target) },
          ...additions.filter(item => item.target !== target)];
        const value = await work.sessions.write({ principal, agent: actingSubject, target, changes,
          expectedVersion, idempotencyKey: request.headers.get('idempotency-key') ?? '' },
        () => workRead(work, request, { actingSubject }, session => resolveSessionSelections(session, inputs)));
        return Response.json(value, { status: 201, headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .patch('/v1/me/sessions/:id', { params: t.Object({ id: readUuid }),
      body: t.Object(command, { additionalProperties: false }), response: { 200: sessionResult, ...errors },
    }, async ({ request, params, body }) => {
      if (!work.sessions) return problem(503, 'session_unavailable', 'Sessions are unavailable');
      try {
        const principal = await own(request, body.actingSubject);
        const { actingSubject, expectedVersion, ...changes } = body;
        const value = await work.sessions.write({ principal, agent: actingSubject,
          id: `https://rezics.com/id/${params.id}`, changes, expectedVersion,
          idempotencyKey: request.headers.get('idempotency-key') ?? '' },
        () => changes.addSelections ? workRead(work, request, { actingSubject },
          session => resolveSessionSelections(session, changes.addSelections!)) : Promise.resolve([]));
        return Response.json(value, { headers: privateHeaders });
      } catch (error) { return failure(error); }
    });
}
