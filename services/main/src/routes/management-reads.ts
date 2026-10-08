import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../modules/account/verify-assertion.ts';
import { auditKind, auditPage, managementQuery, MODERATION_CONTEXT_COST, moderationContext, moderationKind,
  moderationPage, reportReason } from '../modules/management-reads/read-contract.ts';
import { idList, readWorkContext } from '../modules/management-reads/context.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import { workReadError } from './work-reads.ts';
import { ManagementReadLimit, ManagementReadMissing, ManagementReadUnavailable }
  from '../modules/management-reads/read-store.ts';
import { workRead, WorkReadInvalid, WorkReadMissing, WorkReadMoved } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { decisionBasisPage, DECISION_BASIS_COST } from '../modules/management-reads/decision-basis.ts';
import { realmOperationError } from './managed-realms.ts';

const problems = { ...authorizedReadProblems, 409: problemResult(409), 422: problemResult(422) };
const detail = { security: [{ bearerAuth: [] }] };
const headers = { 'cache-control': 'private, no-store' };
const params = t.Object({ realm: readUuid });
export const openApiOperations = {
  '/v1/realms/{realm}/moderation': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/realms/{realm}/audit': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/realms/{realm}/moderation/{caseId}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/realms/{realm}/moderation/context': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
} as const;

/** The principal when the token carries `scope`, or null when it was not consented. */
async function consented(work: MainWorkDependencies, request: Request, scope: string) {
  try { return await work.account.verify(request, [scope]); }
  catch (error) { if (error instanceof AccountAssertionDenied) return null; throw error; }
}

function readError(error: unknown): Response {
  if (error instanceof WorkReadInvalid) return problem(400, 'invalid_management_read', error.message);
  if (error instanceof ManagementReadMissing) return problem(404, 'not_found', 'Realm management is unavailable');
  if (error instanceof WorkReadMoved) return problem(409, 'read_basis_changed', 'Restart the read from its first page');
  if (error instanceof ManagementReadLimit) return problem(422, 'management_read_budget_exceeded', error.message);
  if (error instanceof ManagementReadUnavailable) return problem(503, 'management_read_unavailable', error.message);
  if (error instanceof AccountAssertionDenied) return problem(401, 'unauthorized', 'Authentication is required');
  if (error instanceof AccountAssertionUnavailable) return problem(503, 'account_unavailable', 'Account is unavailable');
  return commandError(error);
}

export function managementReadRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/realms/:realm/moderation/:caseId', { params: t.Object({ realm: readUuid, caseId: readUuid }), detail,
      query: t.Object({ ...managementQuery, limit: t.Optional(t.Integer({ minimum: 1, maximum: DECISION_BASIS_COST.reports })) },
        { additionalProperties: false }), response: { 200: decisionBasisPage, ...problems },
    }, async ({ request, params: path, query }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        if (!work.managementDecisionBasis) throw new ManagementReadUnavailable('Decision basis owner is unavailable');
        return Response.json(await work.managementDecisionBasis.read(principal, `https://rezics.com/id/${path.realm}`, path.caseId, query), { headers });
      } catch (error) {
        if (error instanceof WorkReadInvalid || error instanceof WorkReadMoved || error instanceof ManagementReadUnavailable) return readError(error);
        return realmOperationError(error);
      }
    })
    // Declared before `:caseId`, which is a UUID and never this word.
    .get('/v1/realms/:realm/moderation/context', { params, detail,
      query: t.Object({ actingSubject: readId,
        agents: t.Optional(t.String({ maxLength: MODERATION_CONTEXT_COST.agents * 60 })),
        works: t.Optional(t.String({ maxLength: MODERATION_CONTEXT_COST.works * 60 })) }, { additionalProperties: false }),
      response: { 200: moderationContext, ...problems },
    }, async ({ request, params: path, query }) => {
      try {
        const agents = idList(query.agents, MODERATION_CONTEXT_COST.agents);
        const works = idList(query.works, MODERATION_CONTEXT_COST.works);
        // Reports history needs the moderation consent, submissions history the review one, as the queue does.
        const [moderator, reviewer] = await Promise.all([consented(work, request, 'governance:decide'),
          consented(work, request, 'realm:adopt')]);
        const principal = moderator ?? reviewer;
        if (!principal) throw new AccountAssertionDenied('A management scope is required');
        if (!work.managementReads) throw new ManagementReadUnavailable('Management owner is unavailable');
        const realm = `https://rezics.com/id/${path.realm}`;
        const people = await work.managementReads.people(principal, realm, query.actingSubject, agents,
          { reports: !!moderator, submissions: !!reviewer && reviewer.subject === principal.subject
            && reviewer.issuer === principal.issuer });
        const context = works.length ? await workRead(work, request, { actingSubject: query.actingSubject },
          session => readWorkContext(session, works)) : [];
        return Response.json({ profile: 'moderation-context-v1', people, works: context }, { headers });
      } catch (error) {
        if (error instanceof WorkReadMissing) return problem(404, 'not_found', 'Realm management is unavailable');
        if (error instanceof WorkReadInvalid || error instanceof ManagementReadMissing
          || error instanceof ManagementReadUnavailable || error instanceof AccountAssertionDenied
          || error instanceof AccountAssertionUnavailable) return readError(error);
        return workReadError(error);
      }
    })
    .get('/v1/realms/:realm/moderation', { params, detail,
      query: t.Object({ ...managementQuery,
        state: t.Optional(t.Union([t.Literal('open'), t.Literal('closed')])),
        type: t.Optional(moderationKind), reason: t.Optional(reportReason) },
      { additionalProperties: false }),
      response: { 200: moderationPage, ...problems },
    }, async ({ request, params: path, query }) => {
      try {
        const principal = await work.account.verify(request,
          [query.type?.endsWith('_submission') ? 'realm:adopt' : 'governance:decide']);
        // An unfiltered page aggregates only consented families. Access grants
        // do not widen a connected application's OAuth consent ceiling.
        let includeSubmissions = false;
        if (!query.type) {
          try {
            const reviewer = await work.account.verify(request, ['realm:adopt']);
            includeSubmissions = reviewer.issuer === principal.issuer && reviewer.subject === principal.subject;
          } catch (error) { if (!(error instanceof AccountAssertionDenied)) throw error; }
        }
        if (!work.managementReads) throw new ManagementReadUnavailable('Management owner is unavailable');
        const realm = `https://rezics.com/id/${path.realm}`;
        const result = await work.managementReads.moderation(principal, realm, query,
          query.state ?? 'open', query.type ?? null, includeSubmissions, query.reason ?? null);
        return Response.json(result, { headers });
      } catch (error) { return readError(error); }
    })
    .get('/v1/realms/:realm/audit', { params, detail,
      query: t.Object({ ...managementQuery,
        kind: t.Optional(auditKind) }, { additionalProperties: false }),
      response: { 200: auditPage, ...problems },
    }, async ({ request, params: path, query }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        if (!work.managementReads) throw new ManagementReadUnavailable('Management owner is unavailable');
        const realm = `https://rezics.com/id/${path.realm}`;
        return Response.json(await work.managementReads.audit(principal, realm, query,
          query.kind ?? null), { headers });
      } catch (error) { return readError(error); }
    });
}
