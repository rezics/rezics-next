import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { RealmReplyConflict, RealmReplyDenied, RealmReplyInvalid,
  RealmReplyStale, RealmReplyUnavailable } from '../modules/realm-reply/content-store.ts';
import { realmReplyDigest } from '../modules/realm-reply/store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const generation = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
const optionalNative = t.Nullable(native);
const optionalUuid = t.Nullable(uuid);
const replyBody = t.Object({ profile: t.Literal('realm-reply-identity-v1'), reply: native,
  variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }), revisionId: uuid,
  author: native, rootTarget: native, rootRevision: t.String({ minLength: 1, maxLength: 300 }),
  parentReply: optionalNative, parentRevision: optionalUuid, contextRevision: optionalNative,
}, { additionalProperties: false });
const replyResult = t.Object({ profile: t.Literal('realm-reply-identity-v1'),
  reply: native, variantId: t.String(), revisionId: uuid, author: native,
  rootTarget: native, rootRevision: t.String(), parentReply: optionalNative,
  parentRevision: optionalUuid, contextRevision: optionalNative, replayed: t.Boolean() });
const reviewBody = t.Object({ profile: t.Literal('realm-reply-review-v1'),
  realm: native, reply: native, revisionId: uuid, revisionDigest: digest,
  expectedGeneration: generation, supersedes: optionalUuid,
  outcome: t.Union([t.Literal('approved'), t.Literal('rejected'),
    t.Literal('unavailable'), t.Literal('revoked')]),
  method: t.Union([t.Literal('human'), t.Literal('ai')]),
  methodRevision: t.String({ minLength: 1, maxLength: 300 }), dependencyDigest: digest,
  reasonReference: t.Nullable(t.String({ minLength: 1, maxLength: 128 })),
  actingSubject: native,
}, { additionalProperties: false });
const reviewResult = t.Object({ profile: t.Literal('realm-reply-review-v1'),
  decisionId: uuid, realm: native, reply: native, revisionId: uuid,
  generation, outcome: reviewBody.properties.outcome,
  revisionDigest: digest, replayed: t.Boolean() });
const placementBody = t.Object({ profile: t.Literal('realm-reply-placement-v1'),
  realm: native, reply: native, revisionId: uuid, revisionDigest: digest,
  reviewDecisionId: t.Nullable(uuid), expectedHead: optionalNative, actingSubject: native,
}, { additionalProperties: false });
const placementResult = t.Object({ profile: t.Literal('realm-reply-placement-v1'),
  placement: native, realm: native, reply: native, revisionId: uuid,
  reviewDecisionId: uuid, replayed: t.Boolean() });
const visibleResult = t.Object({ profile: t.Literal('realm-reply-placement-v1'),
  placement: native, realm: native, reply: native, revisionId: uuid,
  reviewDecisionId: uuid, rootTarget: native, author: native });
const countResult = t.Object({ profile: t.Literal('realm-reply-root-count-v1'),
  realm: native, rootTarget: native, count: t.Integer({ minimum: 0, maximum: 64 }),
  complete: t.Boolean() });
const noStore = { headers: { 'cache-control': 'no-store' } };

function replyError(error: unknown): Response {
  if (error instanceof RealmReplyInvalid) return problem(400, 'invalid_realm_reply', error.message);
  if (error instanceof RealmReplyDenied) return problem(403, 'realm_reply_denied', error.message);
  if (error instanceof RealmReplyStale) return problem(409, 'realm_reply_stale', error.message);
  if (error instanceof RealmReplyConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof RealmReplyUnavailable) return problem(503, 'realm_reply_unavailable', error.message);
  return commandError(error);
}
function key(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

export const openApiOperations = {
  '/v1/realm-replies': { post: { bearer: true, idempotencyKey: true } },
  '/v1/realm-reply-reviews': { post: { bearer: true, idempotencyKey: true } },
  '/v1/realm-reply-placements': { post: { bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/replies/{reply}': { get: { bearer: true } },
  '/v1/realms/{realm}/reply-roots/{rootTarget}/count': { get: { bearer: true } },
} as const;

export function realmReplyRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/realm-replies', { body: replyBody,
      response: { 200: replyResult, 201: replyResult, ...writeProblems } },
    async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['work:edit']);
        if (!work.realmReplies) return problem(503, 'realm_reply_unavailable', 'Realm replies are unavailable');
        const idempotencyKey = key(request);
        if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const { profile: _profile, ...input } = body;
        const result = await work.realmReplies.create(principal, input, idempotencyKey,
          realmReplyDigest(body));
        return Response.json({ profile: 'realm-reply-identity-v1', ...result },
          { ...noStore, status: result.replayed ? 200 : 201 });
      } catch (error) { return replyError(error); }
    })
    .post('/v1/realm-reply-reviews', { body: reviewBody,
      response: { 200: reviewResult, 201: reviewResult, ...writeProblems } },
    async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['realm:adopt']);
        if (!work.realmReplies) return problem(503, 'realm_reply_unavailable', 'Realm replies are unavailable');
        const idempotencyKey = key(request);
        if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const { profile: _profile, actingSubject, ...input } = body;
        const result = await work.realmReplies.review(principal, actingSubject,
          input, idempotencyKey, realmReplyDigest(body));
        return Response.json({ profile: 'realm-reply-review-v1', ...result },
          { ...noStore, status: result.replayed ? 200 : 201 });
      } catch (error) { return replyError(error); }
    })
    .post('/v1/realm-reply-placements', { body: placementBody,
      response: { 200: placementResult, 201: placementResult, ...writeProblems } },
    async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['realm:adopt']);
        if (!work.realmReplies) return problem(503, 'realm_reply_unavailable', 'Realm replies are unavailable');
        const idempotencyKey = key(request);
        if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const { profile: _profile, actingSubject, ...input } = body;
        const result = await work.realmReplies.place(principal, actingSubject,
          input, idempotencyKey, realmReplyDigest(body));
        return Response.json({ profile: 'realm-reply-placement-v1', ...result },
          { ...noStore, status: result.replayed ? 200 : 201 });
      } catch (error) { return replyError(error); }
    })
    .get('/v1/realms/:realm/replies/:reply', {
      params: t.Object({ realm: native, reply: native }),
      query: t.Object({ actingSubject: native }, { additionalProperties: false }),
      response: { 200: visibleResult, ...authorizedReadProblems, 404: problemResult(404) },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.realmReplies) return problem(503, 'realm_reply_unavailable', 'Realm replies are unavailable');
        const visible = await work.realmReplies.visible(params.realm, params.reply);
        if (!visible || !await work.access.canReadWork(principal, query.actingSubject,
          visible.rootTarget)) return problem(404, 'realm_reply_unavailable', 'Reply is unavailable');
        return Response.json({ profile: 'realm-reply-placement-v1', ...visible }, noStore);
      } catch (error) { return replyError(error); }
    })
    .get('/v1/realms/:realm/reply-roots/:rootTarget/count', {
      params: t.Object({ realm: native, rootTarget: native }),
      query: t.Object({ actingSubject: native }, { additionalProperties: false }),
      response: { 200: countResult, ...authorizedReadProblems, 404: problemResult(404) },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.realmReplies) return problem(503, 'realm_reply_unavailable', 'Realm replies are unavailable');
        if (!await work.access.canReadWork(principal, query.actingSubject, params.rootTarget)) {
          return problem(404, 'realm_reply_unavailable', 'Reply root is unavailable');
        }
        const count = await work.realmReplies.rootCount(params.realm, params.rootTarget);
        return Response.json({ profile: 'realm-reply-root-count-v1', ...count }, noStore);
      } catch (error) { return replyError(error); }
    });
}
