import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { AdmissionConflict, AdmissionDenied } from '../modules/access/admission.ts';
import { ControlConflict, ControlDenied, ControlInvalid, ControlStale, ControlUnavailable } from '../modules/access/topology-control.ts';
import { EditorialBlocked, EditorialInvalid, EditorialReceiptInvalid } from '../modules/editorial-review/contract.ts';
import type { EditorialCall, CommandResult } from '../modules/editorial-review/store.ts';
import { InvalidWorkMetadata } from '../modules/work/metadata-schema.ts';
import { InvalidSemanticValue, UnsupportedSemanticValue } from '../modules/semantic/value.ts';
import { semanticError } from './semantic.ts';
import { workReadError } from './work-reads.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';

export const openApiOperations = {
  '/v1/editorial/proposals': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true }, get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/editorial/proposals/{proposal}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/editorial/proposals/{proposal}/revisions': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/editorial/proposals/{proposal}/reviews': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/editorial/proposals/{proposal}/decisions': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/editorial/proposals/{proposal}/withdrawal': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/editorial/proposals/{proposal}/reversal': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/editorial/proposals/{proposal}/recovery': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: false } },
} as const;

const uuid = t.String({ format: 'uuid' });
const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const ref = t.String({ minLength: 1,maxLength: 512 });
const n = t.Integer({ minimum: 1 });
const context = t.Union([native,t.Literal('urn:rezics:context:global')]);
const heads = t.Array(t.Object({ component: ref,head: t.Nullable(ref) },{ additionalProperties: false }),{ minItems: 1,maxItems: 32 });
const evidence = t.Array(t.Object({ resource: ref,revision: ref,locator: t.Nullable(t.String({ maxLength: 4000 })) },
  { additionalProperties: false }),{ maxItems: 32 });
const target = t.Object({ resource: native,revision: native,context,work: t.Nullable(native) });
const receipt = t.Object({ receipt: ref,proposal: uuid,revision: n,candidateDigest: t.String(),operationKey: ref,
  beforeHeads: heads,afterHeads: heads,candidate: t.Unknown(),before: t.Unknown(),owner: t.Unknown(),
  commands: t.Optional(t.Array(t.Object({ key: ref,outcome: t.Union([t.Literal('applied'),t.Literal('rejected'),
    t.Literal('dependency_rejected')]),receipt: t.Nullable(ref),result: t.Unknown() }),{ maxItems: 2048 })) });
const terminalOutcome = t.Union([t.Literal('applied'),t.Literal('rejected'),t.Literal('withdrawn')]);
const decision = t.Object({ proposal: uuid,revision: n,actor: native,outcome: terminalOutcome,
  receipt: t.Nullable(receipt),reverts: t.Nullable(uuid) });
export const editorialBlocker = t.Union([
  t.Object({ code: t.Literal('stale_revision'),latestRevision: n }),
  t.Object({ code: t.Literal('stale_base'),expectedHeads: heads,actualHeads: heads }),
  t.Object({ code: t.Literal('self_review') }),t.Object({ code: t.Literal('review_authority_required') }),
  t.Object({ code: t.Literal('owner_authority_required'),action: ref,scope: ref }),
  t.Object({ code: t.Literal('owner_command_refused'),key: ref,reason: ref }),
  t.Object({ code: t.Literal('required_approvals'),required: n,received: t.Integer({ minimum: 0 }) }),
  t.Object({ code: t.Literal('terminal_decision'),outcome: terminalOutcome }),
  t.Object({ code: t.Literal('owner_unavailable') }),t.Object({ code: t.Literal('revision_required') }),
  t.Object({ code: t.Literal('budget_exhausted') }),
  t.Object({ code: t.Literal('apply_pending'),operationKey: ref }),
]);
const blockedProblem = (status: number) => t.Object({ ...problemResult(status).properties,blocker: t.Optional(editorialBlocker) });
const problems = { ...writeProblems,...authorizedReadProblems,403: blockedProblem(403),409: blockedProblem(409),
  503: blockedProblem(503),422: problemResult(422) };
const commandResult = t.Object({ profile: t.Literal('editorial-command-v1'),proposal: uuid,revision: n,
  outcome: t.Union([t.Literal('created'),t.Literal('revised'),t.Literal('approve'),t.Literal('request_changes'),
    t.Literal('comment'),t.Literal('applied'),t.Literal('rejected'),t.Literal('withdrawn'),
    t.Literal('apply_pending'),t.Literal('stale_base'),t.Literal('cancelled')]),
  replayed: t.Boolean(),receipt: t.Optional(receipt),blocker: t.Optional(editorialBlocker) });
const proposalRead = t.Object({ profile: t.Literal('editorial-proposal-v1'),
  proposal: t.Object({ id: uuid,kind: t.String(),target,proposer: native,latestRevision: n,
    decision: t.Nullable(decision),reverts: t.Nullable(uuid) }),
  revision: t.Object({ proposal: uuid,n,candidate: t.Unknown(),candidateDigest: t.String(),before: t.Unknown(),baseHeads: heads,evidence }),
  preview: t.Array(t.Object({ path: t.String(),before: t.Unknown(),after: t.Unknown() })),
  state: t.Union([t.Literal('open'),t.Literal('changes_requested'),t.Literal('approved'),terminalOutcome]),
  approvalIds: t.Array(uuid,{ maxItems: 2 }),staleApprovalIds: t.Array(uuid,{ maxItems: 50 }),
  staleApprovalIdsComplete: t.Boolean(),
  blockers: t.Array(editorialBlocker),allowedActions: t.Array(t.Union([t.Literal('revise'),t.Literal('review'),
    t.Literal('apply'),t.Literal('approve-and-apply'),t.Literal('reject'),t.Literal('withdraw'),t.Literal('revert'),t.Literal('recover')])),
  timeline: t.Array(t.Object({ sequence: t.String(),kind: t.String(),actor: native,revision: n,occurredAt: t.String(),
    review: t.Nullable(t.Object({ id: uuid,outcome: t.String(),message: t.String() })) }),{ maxItems: 50 }),
  nextCursor: t.Nullable(t.String()),
});
const params = t.Object({ proposal: uuid });
const revisionFields = { revision: n,candidate: t.Unknown(),baseHeads: heads,evidence };
const message = t.String({ maxLength: 4000 });
const noStore = { headers: { 'cache-control': 'private, no-store' } };
const optionalSecurity: { security: Record<string,string[]>[] } = { security: [{},{ bearerAuth: [] }] };

export function editorialError(error: unknown): Response {
  if (error instanceof EditorialBlocked) {
    const status = ['self_review','review_authority_required','owner_authority_required'].includes(error.blocker.code) ? 403
      : error.blocker.code === 'owner_unavailable' ? 503 : 409;
    return Response.json({ type: `https://rezics.com/problems/editorial_${error.blocker.code}`,
      title: error.blocker.code,status,code: `editorial_${error.blocker.code}`,blocker: error.blocker },
    { status,headers: { ...noStore.headers,'content-type': 'application/problem+json' } });
  }
  if (error instanceof EditorialInvalid || error instanceof ControlInvalid || error instanceof InvalidWorkMetadata
    || error instanceof InvalidSemanticValue || error instanceof UnsupportedSemanticValue) {
    return problem(400,'invalid_editorial_request',error.message);
  }
  if (error instanceof ControlDenied || error instanceof AdmissionDenied) return problem(403,'editorial_denied',error.message);
  if (error instanceof ControlConflict || error instanceof ControlStale || error instanceof AdmissionConflict) {
    return problem(409,'editorial_conflict',error.message);
  }
  if (error instanceof ControlUnavailable || error instanceof EditorialReceiptInvalid) return problem(503,'editorial_unavailable',error.message);
  const semantic = semanticError(error);
  return semantic.status === 503 ? workReadError(error) : semantic;
}

function resultResponse(result: CommandResult, created = false) {
  if (result.blocker) return editorialError(new EditorialBlocked(result.blocker));
  return Response.json({ profile: 'editorial-command-v1',...result },{ status: result.outcome === 'apply_pending' ? 202
    : created && !result.replayed ? 201 : 200,...noStore });
}
export function editorialProposalRoutes(work: MainWorkDependencies) {
  const owner = () => {
    if (!work.editorialReview) throw new ControlUnavailable('Editorial review is unavailable');
    return work.editorialReview;
  };
  const write = async (request: Request, actingSubject: string, scope: 'work:correct' | 'work:review',
    run: (call: EditorialCall,key: string) => Promise<CommandResult>, created = false) => {
    try {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) throw new EditorialInvalid('A valid Idempotency-Key header is required');
      const principal = await work.account.verify(request,[scope]);
      const call = { work,request,principal,actingSubject };
      return resultResponse(await owner().discloseResult(call,await run(call,key)),created);
    } catch (error) { return editorialError(error); }
  };
  const read = async (request: Request, actingSubject = '') => ({ work,request,actingSubject,
    ...(request.headers.has('authorization') ? { principal: await work.account.verify(request,['work:read']) } : {}) });
  return new Elysia()
    .post('/v1/editorial/proposals', {
      body: t.Object({ profile: t.Literal('editorial-proposal-create-v1'),kind: t.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
        target: t.Object({ resource: native,revision: native,context },{ additionalProperties: false }),
        candidate: t.Unknown(),baseHeads: heads,evidence,actingSubject: native },{ additionalProperties: false }),
      response: { 200: commandResult,201: commandResult,...problems },
    }, ({ request,body }) => write(request,body.actingSubject,'work:correct',
      (call,key) => owner().create(call,body,key),true))
    .post('/v1/editorial/proposals/:proposal/revisions', {
      params,body: t.Object({ profile: t.Literal('editorial-proposal-revise-v1'),...revisionFields,actingSubject: native },{ additionalProperties: false }),
      response: { 200: commandResult,...problems },
    }, ({ request,params: path,body }) => write(request,body.actingSubject,'work:correct',
      (call,key) => owner().revise(call,path.proposal,body,key)))
    .post('/v1/editorial/proposals/:proposal/reviews', {
      params,body: t.Object({ profile: t.Literal('editorial-proposal-review-v1'),revision: n,
        outcome: t.Union([t.Literal('approve'),t.Literal('request_changes'),t.Literal('comment')]),message,actingSubject: native },
      { additionalProperties: false }),response: { 200: commandResult,...problems },
    }, ({ request,params: path,body }) => write(request,body.actingSubject,'work:review',
      (call,key) => owner().review(call,path.proposal,body,key)))
    .post('/v1/editorial/proposals/:proposal/decisions', {
      params,body: t.Object({ profile: t.Literal('editorial-proposal-decide-v1'),revision: n,
        outcome: t.Union([t.Literal('applied'),t.Literal('rejected')]),approve: t.Boolean(),message,actingSubject: native },
      { additionalProperties: false }),response: { 200: commandResult,202: commandResult,...problems },
    }, ({ request,params: path,body }) => write(request,body.actingSubject,'work:review',
      (call,key) => owner().decide(call,path.proposal,body,key)))
    .post('/v1/editorial/proposals/:proposal/withdrawal', {
      params,body: t.Object({ profile: t.Literal('editorial-proposal-withdraw-v1'),revision: n,actingSubject: native },
        { additionalProperties: false }),response: { 200: commandResult,...problems },
    }, ({ request,params: path,body }) => write(request,body.actingSubject,'work:correct',
      (call,key) => owner().withdraw(call,path.proposal,body.revision,key)))
    .post('/v1/editorial/proposals/:proposal/reversal', {
      params,body: t.Object({ profile: t.Literal('editorial-proposal-revert-v1'),evidence,actingSubject: native },
        { additionalProperties: false }),response: { 200: commandResult,201: commandResult,...problems },
    }, ({ request,params: path,body }) => write(request,body.actingSubject,'work:correct',
      (call,key) => owner().revert(call,path.proposal,body.evidence,key),true))
    .get('/v1/editorial/proposals/:proposal', { params,detail: optionalSecurity,
      query: t.Object({ actingSubject: t.Optional(native),limit: t.Optional(t.Numeric({ minimum: 1,maximum: 50 })),
        cursor: t.Optional(t.String({ maxLength: 2048 })) },{ additionalProperties: false }),
      response: { 200: proposalRead,...problems },
    }, async ({ request,params: path,query }) => {
      try { return Response.json(await owner().get(await read(request,query.actingSubject),path.proposal,query.limit,query.cursor),noStore); }
      catch (error) { return editorialError(error); }
    })
    .get('/v1/editorial/proposals', { detail: optionalSecurity,
      query: t.Object({ filter: t.Union([t.Literal('mine'),t.Literal('review-requested'),t.Literal('target')]),target: t.Optional(native),
        actingSubject: t.Optional(native),limit: t.Optional(t.Numeric({ minimum: 1,maximum: 50 })),cursor: t.Optional(t.String({ maxLength: 2048 })) },
      { additionalProperties: false }),response: { 200: t.Object({ items: t.Array(t.Object({ id: uuid,kind: t.String(),target }),
        { maxItems: 50 }),nextCursor: t.Nullable(t.String()) }),...problems },
    }, async ({ request,query }) => {
      try { return Response.json(await owner().list(await read(request,query.actingSubject),{ ...query,limit: query.limit ?? 50 }),noStore); }
      catch (error) { return editorialError(error); }
    })
    .post('/v1/editorial/proposals/:proposal/recovery', { params,detail: optionalSecurity,
      body: t.Object({ profile: t.Literal('editorial-proposal-recover-v1'),actingSubject: t.Optional(native) },{ additionalProperties: false }),
      response: { 200: proposalRead,202: proposalRead,...problems },
    }, async ({ request,params: path,body }) => {
      try {
        const result = await owner().get(await read(request,body.actingSubject),path.proposal);
        return Response.json(result,{ status: result.blockers.some(blocker => blocker.code === 'apply_pending') ? 202 : 200,...noStore });
      } catch (error) { return editorialError(error); }
    });
}
