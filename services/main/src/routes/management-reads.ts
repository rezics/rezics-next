import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../modules/account/verify-assertion.ts';
import { auditPage, managementQuery, moderationKind, moderationPage } from '../modules/management-reads/read-contract.ts';
import { ManagementReadLimit, ManagementReadMissing, ManagementReadUnavailable }
  from '../modules/management-reads/read-store.ts';
import { WorkReadInvalid, WorkReadMoved } from '../modules/work/read-session.ts';
import { readUuid } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { decisionBasisPage, DECISION_BASIS_COST } from '../modules/management-reads/decision-basis.ts';
import { realmOperationError } from './managed-realms.ts';

const problems = { ...authorizedReadProblems, 409: problemResult(409), 422: problemResult(422) };
const detail = { security: [{ bearerAuth: [] }] };
const headers = { 'cache-control': 'private, no-store' };
const params = t.Object({ realm: readUuid });
export const openApiOperations = {
  '/v1/realms/{realm}/moderation': { get: { bearer: true } },
  '/v1/realms/{realm}/audit': { get: { bearer: true } },
  '/v1/realms/{realm}/moderation/{caseId}': { get: { bearer: true } },
} as const;

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
    .get('/v1/realms/:realm/moderation', { params, detail,
      query: t.Object({ ...managementQuery,
        state: t.Optional(t.Union([t.Literal('open'), t.Literal('closed')])),
        type: t.Optional(moderationKind) },
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
          query.state ?? 'open', query.type ?? null, includeSubmissions);
        return Response.json(result, { headers });
      } catch (error) { return readError(error); }
    })
    .get('/v1/realms/:realm/audit', { params, detail,
      query: t.Object({ ...managementQuery,
        kind: t.Optional(t.Union([t.Literal('content_moderation'), t.Literal('rights_disposition'),
          t.Literal('organization_publication_rejection'), t.Literal('realm_management')])) }, { additionalProperties: false }),
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
