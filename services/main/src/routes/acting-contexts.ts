import { Elysia, t } from 'elysia';
import { actingContextCheck, actingContextDiscovery, actingContextPreference,
  authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export function actingContextRoutes(work: MainWorkDependencies) {
  return new Elysia()
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
        const result = await work.actingContexts.discover(principal);
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
    });
}
