import { Elysia, t } from 'elysia';
import { authorizedReadProblems, readProblems, writeProblems } from '../api-responses.ts';
import { AccountAssertionDenied } from '../modules/account/verify-assertion.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import { GovernanceConflict, GovernanceDenied, GovernanceInvalid, GovernanceStale,
  GovernanceUnavailable } from '../modules/governance/store.ts';
import { CATEGORY_VERSION, correspondenceInput, correspondenceReceipt, publicReportInput,
  publicReportList, publicReportReceipt, publicReportStatus, PUBLIC_REPORT_COST } from '../modules/public-report/contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { governanceError } from './reports.ts';
import { problem } from './problems.ts';
import { workReadError } from './work-reads.ts';

export const openApiOperations = {
  '/v1/public-reports': { post: { exposure: 'public', bearer: false, idempotencyKey: true } },
  '/v1/public-reports/mine': { get: { exposure: 'public', bearer: true } },
  '/v1/public-reports/{caseId}': { get: { exposure: 'public', bearer: false } },
  '/v1/public-reports/{caseId}/correspondence': { post: { exposure: 'public', bearer: false, idempotencyKey: true } },
} as const;
const caseParams = t.Object({ caseId: t.String({ format: 'uuid' }) });
const cursorQuery = t.Object({ cursor: t.Optional(t.String({ format: 'uuid' })) }, { additionalProperties: false });
const caseQuery = t.Object({ ...cursorQuery.properties,
  limit: t.Optional(t.Integer({ minimum: 1, maximum: PUBLIC_REPORT_COST.page })) }, { additionalProperties: false });
const noStore = { 'cache-control': 'no-store' };
const credential = (request: Request) => request.headers.get('x-rezics-case-credential') ?? '';
const key = (request: Request) => request.headers.get('idempotency-key') ?? '';

async function optionalReporter(work: MainWorkDependencies, request: Request): Promise<VerifiedPrincipal | null> {
  if (!request.headers.has('authorization')) return null;
  try { return await work.account.verify(request, []); }
  catch (error) {
    if (error instanceof AccountAssertionDenied) return null;
    // Account availability cannot prevent contact-only safety intake.
    return null;
  }
}

function reportError(error: unknown): Response {
  if (error instanceof GovernanceDenied) return problem(404, 'case_unavailable', 'Case is unavailable');
  if (error instanceof GovernanceConflict || error instanceof GovernanceInvalid
    || error instanceof GovernanceStale || error instanceof GovernanceUnavailable) return governanceError(error);
  return workReadError(error);
}

function privateError(error: unknown): Response {
  const response = reportError(error);
  response.headers.set('cache-control', 'no-store');
  return response;
}

/** Account-free safety intake and a header-only private case inbox. */
export function publicReportRoutes(work: MainWorkDependencies) {
  const unavailable = () => problem(503, 'governance_unavailable', 'Governance is unavailable');
  return new Elysia()
    .post('/v1/public-reports', { body: publicReportInput,
      response: { 200: publicReportReceipt, 201: publicReportReceipt, ...writeProblems, ...readProblems } }, async ({ request, body }) => {
      try {
        if (!work.publicReports) return unavailable();
        const reporter = await optionalReporter(work, request);
        const result = await work.publicReports.submit(body, key(request), request, reporter);
        return Response.json({ profile: CATEGORY_VERSION, ...result },
          { status: result.replayed ? 200 : 201, headers: noStore });
      } catch (error) { return privateError(error); }
    })
    .get('/v1/public-reports/mine', { query: cursorQuery,
      response: { 200: publicReportList, ...authorizedReadProblems } }, async ({ request, query }) => {
      try {
        if (!work.publicReports) return unavailable();
        const reporter = await work.account.verify(request, []);
        return Response.json({ profile: CATEGORY_VERSION, ...await work.publicReports.list(reporter, query.cursor) },
          { headers: noStore });
      } catch (error) { return privateError(error); }
    })
    .get('/v1/public-reports/:caseId', { params: caseParams, query: caseQuery,
      headers: t.Object({ 'x-rezics-case-credential': t.Optional(t.String()) }),
      response: { 200: publicReportStatus, ...readProblems } }, async ({ request, params, query }) => {
      try {
        if (!work.publicReports) return unavailable();
        return Response.json({ profile: CATEGORY_VERSION,
          ...await work.publicReports.status(params.caseId, credential(request), query.cursor, query.limit) }, { headers: noStore });
      } catch (error) { return privateError(error); }
    })
    .post('/v1/public-reports/:caseId/correspondence', { params: caseParams, body: correspondenceInput,
      headers: t.Object({ 'x-rezics-case-credential': t.Optional(t.String()) }),
      response: { 200: correspondenceReceipt, ...writeProblems, ...readProblems } },
      async ({ request, params, body }) => {
        try {
          if (!work.publicReports) return unavailable();
          return Response.json({ profile: CATEGORY_VERSION,
            ...await work.publicReports.correspond(params.caseId, credential(request), key(request), body) },
          { headers: noStore });
        } catch (error) { return privateError(error); }
      });
}
