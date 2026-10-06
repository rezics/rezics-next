import { Elysia, t } from 'elysia';
import { readerLanguages } from '../modules/display-language/select.ts';
import { AccountAssertionInsufficientScope } from '../modules/account/verify-assertion.ts';
import { actingContextCheck, actingContextDiscovery, actingContextPreference,
  authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/me/agents': { get: { exposure: 'public', bearer: true } },
  '/v1/me/acting-contexts': { get: { exposure: 'public', bearer: true } },
  '/v1/me/acting-context-checks': { post: { exposure: 'public', bearer: true } },
  '/v1/me/acting-context-preferences/work.create': { put: { exposure: 'public', bearer: true } },
  '/v1/me/session-agent': { get: { exposure: 'public', bearer: true },
    put: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/me/main-agent-preference': { get: { exposure: 'public', bearer: true },
    put: { exposure: 'public', bearer: true, idempotencyKey: true } },
} as const;

const agentDiscovery = t.Object({ profile: t.Literal('agent-discovery-v1'),
  items: t.Array(t.Object({ actingSubject: t.String(),
    kind: t.Nullable(t.Union([t.Literal('person'), t.Literal('pen-name'),
      t.Literal('organization'), t.Literal('service')])), handle: t.Nullable(t.String()),
    displayName: t.Nullable(t.Object({ value: t.String({ maxLength: 200 }),
      language: t.String(), direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]) })),
  }), { maxItems: 50 }), complete: t.Literal(true) });

const agentChoice = t.Object({ actingSubject: t.Nullable(t.String()),
  eligible: t.Boolean(), revision: t.Nullable(t.String()) });
const sessionAgentRead = t.Object({ profile: t.Literal('session-agent-v1'),
  sessionAgent: agentChoice, mainAgent: agentChoice,
  initialActingSubject: t.Nullable(t.String()) });
const mainAgentRead = t.Object({ profile: t.Literal('main-agent-preference-v1'),
  mainAgent: agentChoice });
const choiceWrite = t.Object({ profile: t.Union([t.Literal('session-agent-v1'),
  t.Literal('main-agent-preference-v1')]), actingSubject: t.Nullable(t.String()),
revision: t.String(), replayed: t.Boolean() });
const choiceBody = t.Object({
  actingSubject: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
  expectedRevision: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
}, { additionalProperties: false });
const sessionKeyHeader = t.Object({
  'x-session-key': t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }),
});
const sessionWriteHeaders = t.Object({
  'x-session-key': t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }),
  'idempotency-key': t.String({ minLength: 1, maxLength: 128 }),
});
const choiceWriteHeaders = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 128 }),
});

function identityError(error: unknown) {
  return error instanceof AccountAssertionInsufficientScope
    ? problem(403, 'insufficient_scope', 'Agent identity permission is required')
    : commandError(error);
}

export function actingContextRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/me/agents', {
      query: t.Object({ languages: t.Optional(t.String({ maxLength: 400 })) },
        { additionalProperties: false }),
      response: { 200: agentDiscovery, ...authorizedReadProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, ['agent:create']);
        const contexts = work.actingContextDiscovery ?? work.actingContexts;
        if (!contexts) return problem(503, 'acting_context_unavailable', 'Agents are unavailable');
        const result = await contexts.discoverAgents(principal,
          readerLanguages(query.languages, request.headers.get('accept-language')));
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return identityError(error); }
    })
    .get('/v1/me/acting-contexts', {
      query: t.Object({ task: t.Literal('work.create') },
        { additionalProperties: false }),
      response: { 200: actingContextDiscovery, ...authorizedReadProblems },
    }, async ({ request }) => {
      try {
        const principal = await work.account.verify(request, ['work:create']);
        if (!work.actingContexts) {
          return problem(503, 'acting_context_unavailable', 'Acting contexts are unavailable');
        }
        const result = await (work.actingContextDiscovery ?? work.actingContexts).discover(principal);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/me/acting-context-checks', {
      body: t.Union([t.Object({ profile: t.Literal('work-create-acting-context-check-v1'),
        task: t.Literal('work.create'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedAuthorityEpoch: t.String({ pattern: '^(0|[1-9][0-9]*)$' }),
        authorityPath: t.Optional(t.Union([
          t.Literal('represented-agent'), t.Literal('direct-principal')])),
      }, { additionalProperties: false }), t.Object({
        profile: t.Literal('content-draft-acting-context-check-v1'),
        task: t.Literal('content.draft'),
        resource: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedAuthorityEpoch: t.String({ pattern: '^(0|[1-9][0-9]*)$' }),
      }, { additionalProperties: false })]),
      response: { 200: actingContextCheck, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request,
          body.task === 'work.create' ? ['work:create'] : ['work:edit']);
        if (!work.actingContexts) {
          return problem(503, 'acting_context_unavailable', 'Acting contexts are unavailable');
        }
        const result = body.task === 'work.create'
          ? await work.actingContexts.check(principal, body.actingSubject,
            body.expectedAuthorityEpoch, body.authorityPath)
          : await work.actingContexts.checkContentDraft(principal, body.resource,
            body.actingSubject, body.expectedAuthorityEpoch);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .put('/v1/me/acting-context-preferences/work.create', {
      body: t.Object({ profile: t.Literal('work-create-acting-context-preference-v1'),
        task: t.Literal('work.create'),
        actingSubject: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        expectedRevision: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
        idempotencyKey: t.String({ minLength: 1, maxLength: 128 }),
      }, { additionalProperties: false }),
      response: { 200: actingContextPreference, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['work:create']);
        if (!work.actingContexts) {
          return problem(503, 'acting_context_unavailable', 'Acting contexts are unavailable');
        }
        const result = await work.actingContexts.setPreference(principal,
          { actingSubject: body.actingSubject,
            expectedRevision: body.expectedRevision, idempotencyKey: body.idempotencyKey });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/me/session-agent', {
      headers: sessionKeyHeader,
      response: { 200: sessionAgentRead, ...authorizedReadProblems },
    }, async ({ request }) => {
      try {
        const principal = await work.account.verify(request, ['agent:create']);
        if (!work.sessionAgents) return problem(503, 'acting_context_unavailable', 'Session Agent is unavailable');
        const result = await work.sessionAgents.readSession(principal,
          request.headers.get('x-session-key') ?? '');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return identityError(error); }
    })
    .put('/v1/me/session-agent', {
      headers: sessionWriteHeaders,
      body: choiceBody,
      response: { 200: choiceWrite, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['agent:create']);
        if (!work.sessionAgents) return problem(503, 'acting_context_unavailable', 'Session Agent is unavailable');
        const result = await work.sessionAgents.setSession(principal,
          request.headers.get('x-session-key') ?? '', {
            actingSubject: body.actingSubject, expectedRevision: body.expectedRevision,
            idempotencyKey: request.headers.get('idempotency-key') ?? '' });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return identityError(error); }
    })
    .get('/v1/me/main-agent-preference', {
      response: { 200: mainAgentRead, ...authorizedReadProblems },
    }, async ({ request }) => {
      try {
        const principal = await work.account.verify(request, ['agent:create']);
        if (!work.sessionAgents) return problem(503, 'acting_context_unavailable', 'Main Agent is unavailable');
        const result = await work.sessionAgents.readMain(principal);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return identityError(error); }
    })
    .put('/v1/me/main-agent-preference', {
      headers: choiceWriteHeaders,
      body: choiceBody,
      response: { 200: choiceWrite, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['agent:create']);
        if (!work.sessionAgents) return problem(503, 'acting_context_unavailable', 'Main Agent is unavailable');
        const result = await work.sessionAgents.setMain(principal, {
          actingSubject: body.actingSubject, expectedRevision: body.expectedRevision,
          idempotencyKey: request.headers.get('idempotency-key') ?? '' });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return identityError(error); }
    });
}
