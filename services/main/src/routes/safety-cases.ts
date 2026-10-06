import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import {
  decisionFields,
  decisionResult,
  governanceError,
  MODERATION_SCOPE,
  requireGovernanceKey,
} from './reports.ts';
import { reportCategory } from '../modules/public-report/contract.ts';
import { reasons } from '../modules/safety-queue/contract.ts';
import { problem } from './problems.ts';

const agent = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ format: 'uuid' });
const key = t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' });
const caseTarget = t.Object({ owner: t.String(), resource: t.String(), component: t.String() });
const queuePage = t.Object({
  items: t.Array(
    t.Object({
      caseId: uuid,
      kind: t.String(),
      urgent: t.Boolean(),
      restricted: t.Boolean(),
      generation: t.String(),
      decisionHead: t.Nullable(uuid),
      openedAt: t.String(),
      target: t.Nullable(caseTarget),
      category: t.Nullable(t.String()),
      contentLanguage: t.Nullable(t.String()),
      dueAt: t.Nullable(t.String()),
      claimedBy: t.Nullable(agent),
    }),
  ),
  nextCursor: t.Nullable(t.String()),
  sourcePosition: t.Object({ dataEpoch: t.String(), sequence: t.String() }),
});
const duePage = t.Object({
  items: t.Array(t.Object({ stepId: uuid, caseId: uuid, step: t.String(), dueAt: t.String() })),
  nextCursor: t.Nullable(uuid),
});
const noticePage = t.Object({
  items: t.Array(
    t.Object({
      id: uuid,
      caseId: uuid,
      decisionId: uuid,
      credential: t.String(),
      reasons: t.Object({ ...reasons.properties, rule: decisionFields.rule }),
    }),
  ),
  nextCursor: t.Nullable(uuid),
});
const caseView = t.Object({
  caseId: uuid,
  kind: t.String(),
  urgent: t.Boolean(),
  generation: t.String(),
  state: t.String(),
  reports: t.Array(t.Object({ reportId: uuid, evidenceDigest: t.String(), category: t.String() })),
  reportsNextCursor: t.Nullable(uuid),
  steps: t.Array(
    t.Object({
      id: uuid,
      kind: t.String(),
      process: t.String(),
      reportId: t.Nullable(uuid),
      decisionId: t.Nullable(uuid),
      party: t.Nullable(t.String()),
      partySubject: t.Nullable(agent),
      statement: t.Nullable(t.String()),
      documentDigest: t.Nullable(t.String()),
      contentLanguage: t.Nullable(t.String()),
      declarations: t.Nullable(t.Record(t.String(), t.Unknown())),
      occurredAt: t.String(),
      dueAt: t.Nullable(t.String()),
      recordedAt: t.String(),
    }),
    { maxItems: 50 },
  ),
  stepsNextCursor: t.Nullable(uuid),
  decision: t.Nullable(
    t.Object({
      ...decisionResult.properties,
      profile: t.Optional(t.String()),
      statementOfReasons: t.Nullable(
        t.Object({ ...reasons.properties, rule: decisionFields.rule }),
      ),
    }),
  ),
  targets: decisionFields.targets,
});
const noStore = { headers: { 'cache-control': 'no-store' } };
export const openApiOperations = {
  '/v1/safety-cases': { get: { exposure: 'public', bearer: true } },
  '/v1/safety-cases/due-steps': { get: { exposure: 'public', bearer: true } },
  '/v1/safety-cases/{caseId}': { get: { exposure: 'public', bearer: true } },
  '/v1/safety-cases/{caseId}/claim': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/safety-cases/{caseId}/preservation-holds': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/safety-cases/{caseId}/decisions': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/safety-decisions/{decisionId}/cancellation': {
    post: { exposure: 'public', bearer: true, idempotencyKey: true },
  },
  '/v1/safety-notices': { get: { exposure: 'public', bearer: true } },
} as const;

export function safetyCaseRoutes(work: MainWorkDependencies) {
  const store = work.governance?.store;
  const unavailable = () => problem(503, 'governance_unavailable', 'Governance is unavailable');
  return new Elysia()
    .get(
      '/v1/safety-cases',
      {
        query: t.Object({
          actingSubject: agent,
          urgent: t.Optional(t.Boolean()),
          category: t.Optional(reportCategory),
          contentLanguage: t.Optional(t.String({ maxLength: 255 })),
          dueBefore: t.Optional(t.String({ format: 'date-time' })),
          cursor: t.Optional(t.String({ maxLength: 4000 })),
          limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
        }),
        response: { 200: queuePage, ...authorizedReadProblems },
      },
      async ({ request, query }) => {
        try {
          const principal = await work.account.verify(request, [MODERATION_SCOPE]);
          if (!store) return unavailable();
          return Response.json(await store.safety.page(principal, query), noStore);
        } catch (error) {
          return governanceError(error);
        }
      },
    )
    .get(
      '/v1/safety-cases/due-steps',
      {
        query: t.Object({ actingSubject: agent, cursor: t.Optional(uuid) }),
        response: { 200: duePage, ...authorizedReadProblems },
      },
      async ({ request, query }) => {
        try {
          const principal = await work.account.verify(request, [MODERATION_SCOPE]);
          if (!store) return unavailable();
          return Response.json(
            await store.safety.due(principal, query.actingSubject, query.cursor),
            noStore,
          );
        } catch (error) {
          return governanceError(error);
        }
      },
    )
    .get(
      '/v1/safety-cases/:caseId',
      {
        params: t.Object({ caseId: uuid }),
        query: t.Object({
          actingSubject: agent,
          reportCursor: t.Optional(uuid),
          stepCursor: t.Optional(uuid),
        }),
        response: { 200: caseView, ...authorizedReadProblems },
      },
      async ({ request, params, query }) => {
        try {
          const principal = await work.account.verify(request, [MODERATION_SCOPE]);
          if (!store) return unavailable();
          return Response.json(
            await store.readSafetyCase(
              principal,
              query.actingSubject,
              params.caseId,
              query.reportCursor,
              query.stepCursor,
            ),
            noStore,
          );
        } catch (error) {
          return governanceError(error);
        }
      },
    )
    .post(
      '/v1/safety-cases/:caseId/claim',
      {
        params: t.Object({ caseId: uuid }),
        body: t.Object({ actingSubject: agent, idempotencyKey: key }),
        response: { 200: t.Object({ caseId: uuid, claimedBy: agent }), ...writeProblems },
      },
      async ({ request, params, body }) => {
        try {
          const principal = await work.account.verify(request, [MODERATION_SCOPE]);
          const keyError = requireGovernanceKey(request, body.idempotencyKey);
          if (keyError) return keyError;
          if (!store) return unavailable();
          return Response.json(
            await store.safety.claim(principal, body.actingSubject, params.caseId),
            noStore,
          );
        } catch (error) {
          return governanceError(error);
        }
      },
    )
    .post(
      '/v1/safety-cases/:caseId/preservation-holds',
      {
        params: t.Object({ caseId: uuid }),
        body: t.Object({
          actingSubject: agent,
          idempotencyKey: key,
          reason: t.String({ minLength: 1, maxLength: 4000 }),
        }),
        response: { 200: t.Object({ caseId: uuid, holdId: uuid }), ...writeProblems },
      },
      async ({ request, params, body }) => {
        try {
          const principal = await work.account.verify(request, [MODERATION_SCOPE]);
          const keyError = requireGovernanceKey(request, body.idempotencyKey);
          if (keyError) return keyError;
          if (!store) return unavailable();
          return Response.json(
            await store.safety.hold(principal, body.actingSubject, params.caseId, body.reason),
            noStore,
          );
        } catch (error) {
          return governanceError(error);
        }
      },
    )
    .post(
      '/v1/safety-cases/:caseId/decisions',
      {
        params: t.Object({ caseId: uuid }),
        body: t.Object(
          {
            ...decisionFields,
            reasons,
            outcome: t.Union([
              t.Literal('restrict'),
              t.Literal('interim_restrict'),
              t.Literal('final_restrict'),
              t.Literal('dismiss'),
              t.Literal('restore'),
              t.Literal('reverse'),
            ]),
          },
          { additionalProperties: false },
        ),
        response: { 200: decisionResult, 202: decisionResult, ...writeProblems },
      },
      async ({ request, params, body }) => {
        try {
          const principal = await work.account.verify(request, [MODERATION_SCOPE]);
          const keyError = requireGovernanceKey(request, body.idempotencyKey);
          if (keyError) return keyError;
          if (body.caseId !== params.caseId)
            return problem(400, 'invalid_governance_request', 'caseId must match the route');
          if (!store) return unavailable();
          const result = await store.decide(principal, body, true);
          return Response.json(
            { profile: 'moderation-decision-v1', ...result },
            { status: result.operation.status === 'completed' ? 200 : 202, ...noStore },
          );
        } catch (error) {
          return governanceError(error);
        }
      },
    )
    .post(
      '/v1/safety-decisions/:decisionId/cancellation',
      {
        params: t.Object({ decisionId: uuid }),
        body: t.Object({ actingSubject: agent, idempotencyKey: key }),
        response: { 200: decisionResult, ...writeProblems },
      },
      async ({ request, params, body }) => {
        try {
          const principal = await work.account.verify(request, [MODERATION_SCOPE]);
          const keyError = requireGovernanceKey(request, body.idempotencyKey);
          if (keyError) return keyError;
          if (!store) return unavailable();
          return Response.json(
            {
              profile: 'moderation-decision-v1',
              ...(await store.cancelDecision(principal, body.actingSubject, params.decisionId)),
            },
            noStore,
          );
        } catch (error) {
          return governanceError(error);
        }
      },
    )
    .get(
      '/v1/safety-notices',
      {
        query: t.Object({ cursor: t.Optional(uuid) }),
        response: { 200: noticePage, ...authorizedReadProblems },
      },
      async ({ request, query }) => {
        try {
          const principal = await work.account.verify(request, ['governance:report']);
          if (!store) return unavailable();
          return Response.json(await store.safety.notices(principal, query.cursor), noStore);
        } catch (error) {
          return governanceError(error);
        }
      },
    );
}
