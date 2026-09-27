import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../modules/account/verify-assertion.ts';
import { auditPage, managementQuery, moderationPage } from '../modules/management-reads/read-contract.ts';
import { ManagementReadLimit, ManagementReadMissing, ManagementReadUnavailable }
  from '../modules/management-reads/read-store.ts';
import { WorkReadInvalid, WorkReadMoved } from '../modules/work/read-session.ts';
import { readUuid } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const problems = { ...authorizedReadProblems, 409: problemResult(409), 422: problemResult(422) };
const detail = { security: [{ bearerAuth: [] }] };
const headers = { 'cache-control': 'private, no-store' };
const params = t.Object({ realm: readUuid });
export const openApiOperations = {
  '/v1/realms/{realm}/moderation': { get: { bearer: true } },
  '/v1/realms/{realm}/audit': { get: { bearer: true } },
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
    .get('/v1/realms/:realm/moderation', { params, detail,
      query: t.Object({ ...managementQuery,
        state: t.Optional(t.Union([t.Literal('open'), t.Literal('closed')])),
        type: t.Optional(t.Union([t.Literal('content_report'), t.Literal('rights_complaint')])) },
      { additionalProperties: false }),
      response: { 200: moderationPage, ...problems },
    }, async ({ request, params: path, query }) => {
      try {
        const principal = await work.account.verify(request, ['governance:decide']);
        if (!work.managementReads) throw new ManagementReadUnavailable('Management owner is unavailable');
        const realm = `https://rezics.com/id/${path.realm}`;
        const result = await work.managementReads.moderation(principal, realm, query,
          query.state ?? 'open', query.type ?? null);
        return Response.json(result, { headers });
      } catch (error) { return readError(error); }
    })
    .get('/v1/realms/:realm/audit', { params, detail,
      query: t.Object({ ...managementQuery,
        kind: t.Optional(t.Union([t.Literal('content_moderation'), t.Literal('rights_disposition'),
          t.Literal('organization_publication_rejection')])) }, { additionalProperties: false }),
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
