import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { decisionInput, submissionInput, submissionPage, submissionQuery, submissionResult,
  submissionView, withdrawalInput, SubmissionInvalid, SubmissionMissing,
  SubmissionStale, SubmissionUnavailable } from '../modules/realm-submission/schema.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import { WorkReadInvalid, WorkReadMoved } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const problems = { ...writeProblems, ...authorizedReadProblems, 409: problemResult(409) };
const headers = { 'cache-control': 'private, no-store' };
const realmParams = t.Object({ realm: readUuid });
const itemParams = t.Object({ realm: readUuid, submission: readUuid });
const detail = { security: [{ bearerAuth: [] }] };
const keyOf = (request: Request) => {
  const key = request.headers.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) throw new SubmissionInvalid('Idempotency-Key is required');
  return key;
};
function errorResponse(error: unknown) {
  if (error instanceof SubmissionInvalid || error instanceof WorkReadInvalid) return problem(400, 'invalid_submission', error.message);
  if (error instanceof SubmissionMissing) return problem(404, 'submission_unavailable', error.message);
  if (error instanceof SubmissionStale || error instanceof WorkReadMoved) return problem(409, 'submission_stale', error.message);
  if (error instanceof SubmissionUnavailable) return problem(503, 'submission_pending', error.message);
  return commandError(error);
}
export const openApiOperations = {
  '/v1/realms/{realm}/submissions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/submissions/{submission}': { get: { bearer: true } },
  '/v1/realms/{realm}/submissions/{submission}/decisions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/submissions/{submission}/withdrawals': { post: { bearer: true, idempotencyKey: true } },
  '/v1/my/submissions': { get: { bearer: true } },
} as const;

export function realmSubmissionRoutes(work: MainWorkDependencies) {
  const store = () => {
    if (!work.realmSubmissions) throw new SubmissionUnavailable('Submission owner is unavailable');
    return work.realmSubmissions;
  };
  const reads = () => {
    if (!work.realmSubmissionReads) throw new SubmissionUnavailable('Submission owner is unavailable');
    return work.realmSubmissionReads;
  };
  return new Elysia()
    .post('/v1/realms/:realm/submissions', { params: realmParams, body: submissionInput, detail,
      response: { 200: submissionResult, 201: submissionResult, ...problems } },
    async ({ request, params, body }) => {
      try {
        const principal = await work.account.verify(request, ['work:edit']);
        const result = await store().submit(principal, `https://rezics.com/id/${params.realm}`, body, keyOf(request));
        return Response.json(result, { headers, status: result.replayed ? 200 : 201 });
      } catch (error) { return errorResponse(error); }
    })
    .post('/v1/realms/:realm/submissions/:submission/decisions', { params: itemParams,
      body: decisionInput, detail, response: { 200: submissionResult, ...problems } },
    async ({ request, params, body }) => {
      try {
        const principal = await work.account.verify(request, ['realm:adopt']);
        return Response.json(await store().decide(principal, `https://rezics.com/id/${params.realm}`,
          params.submission, body, keyOf(request)), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .post('/v1/realms/:realm/submissions/:submission/withdrawals', { params: itemParams,
      body: withdrawalInput, detail, response: { 200: submissionResult, ...problems } },
    async ({ request, params, body }) => {
      try {
        const principal = await work.account.verify(request, ['work:edit']);
        return Response.json(await store().withdraw(principal, `https://rezics.com/id/${params.realm}`,
          params.submission, body, keyOf(request)), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/my/submissions', { query: t.Object(submissionQuery, { additionalProperties: false }),
      detail, response: { 200: submissionPage, ...problems } }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        return Response.json(await reads().mine(principal, query), { headers });
      } catch (error) { return errorResponse(error); }
    })
    .get('/v1/realms/:realm/submissions/:submission', { params: itemParams,
      query: t.Object({ actingSubject: readId }, { additionalProperties: false }), detail,
      response: { 200: t.Object({ submission: submissionView, internalNote: t.Nullable(t.String()) }), ...problems } },
    async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['realm:adopt']);
        return Response.json(await reads().review(principal, `https://rezics.com/id/${params.realm}`,
          params.submission, query.actingSubject), { headers });
      } catch (error) { return errorResponse(error); }
    });
}
