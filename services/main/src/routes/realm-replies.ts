import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { RealmReplyConflict, RealmReplyDenied, RealmReplyInvalid,
  RealmReplyStale, RealmReplyUnavailable } from '../modules/realm-reply/content-store.ts';
import { realmReplyDigest } from '../modules/realm-reply/store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { resolveTargets, TargetUnavailable, targetRead } from '../modules/target/resolve.ts';
import { readReplyRoot } from '../modules/realm-reply/root.ts';
import { workRead, WorkReadMissing } from '../modules/work/read-session.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import { authoredBodySchema } from '../api-document.ts';
import { problemResult } from '../api-contract.ts';
import { readUuid } from '../modules/work/read-contract.ts';
import { verifyMemberReplyDraftPrincipal } from '../modules/content-publication/reply-draft.ts';
import { RealmAboutPostCommand } from '../modules/realm-reply/about-command.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const nativePath = t.Union([readUuid, native]);
const nativePathIri = (value: string) => value.startsWith('https://rezics.com/id/')
  ? value : `https://rezics.com/id/${value}`;
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const generation = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
const optionalNative = t.Nullable(native);
const optionalUuid = t.Nullable(uuid);
const replyBody = t.Object({ profile: t.Literal('realm-reply-identity-v1'), reply: native, spoiler: t.Optional(t.Boolean()),
  variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }), revisionId: uuid,
  author: native, rootTarget: native, rootRevision: t.String({ minLength: 1, maxLength: 300 }),
  parentReply: optionalNative, parentRevision: optionalUuid, contextRevision: optionalNative,
}, { additionalProperties: false });
const replyResult = t.Object({ profile: t.Literal('realm-reply-identity-v1'),
  reply: native, variantId: t.String(), revisionId: uuid, author: native, spoiler: t.Optional(t.Boolean()),
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
  concepts: t.Optional(t.Array(native, { maxItems: 8, uniqueItems: true })),
  primaryConcept: t.Optional(t.Nullable(native)),
}, { additionalProperties: false });
const placementResult = t.Object({ profile: t.Literal('realm-reply-placement-v1'),
  placement: native, realm: native, reply: native, revisionId: uuid,
  concepts: t.Optional(t.Array(native, { maxItems: 8, uniqueItems: true })),
  primaryConcept: t.Optional(t.Nullable(native)),
  reviewDecisionId: uuid, reviewGeneration: generation, replayed: t.Boolean() });
export const placementWithdrawalBody = t.Object({ profile: t.Literal('realm-reply-placement-withdrawal-v1'),
  realm: native, reply: native, expectedHead: native, expectedRevisionId: uuid, actingSubject: native,
}, { additionalProperties: false });
export const placementWithdrawalResult = t.Object({ profile: t.Literal('realm-reply-placement-withdrawal-v1'),
  realm: native, reply: native, revisionId: uuid, withdrawnPlacement: native, withdrawal: native, replayed: t.Boolean(),
});

const visibleResult = t.Object({ profile: t.Literal('realm-reply-placement-v1'),
  placement: native, realm: native, reply: native, revisionId: uuid,
  reviewDecisionId: uuid, rootTarget: native, author: native });
const countResult = t.Object({ profile: t.Literal('realm-reply-root-count-v1'),
  realm: native, rootTarget: native, count: t.Integer({ minimum: 0, maximum: 64 }),
  complete: t.Boolean() });
const noStore = { headers: { 'cache-control': 'no-store' } };
const aboutPostBody = authoredBodySchema({ profile: t.Literal('realm-about-post-v1'),
  about: native, targetRevision: native, zone: native, path: t.String({ minLength: 1, maxLength: 1024 }),
  routeRevision: native, actingSubject: native,
  language: t.String({ minLength: 1, maxLength: 35, description: 'RFC 5646 language tag; validated by the shared language parser.' }),
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl'), t.Literal('none')]), spoiler: t.Optional(t.Boolean()),
}, 8192, 1);
const aboutPostResult = t.Object({ profile: t.Literal('realm-about-post-v1'), realm: native, about: native,
  author: native, reply: native, revisionId: uuid, placement: native }, { additionalProperties: false });

function replyError(error: unknown): Response {
  if (error instanceof RealmReplyInvalid) return problem(400, 'invalid_realm_reply', error.message);
  if (error instanceof RealmReplyDenied) return problem(403, 'realm_reply_denied', error.message);
  if (error instanceof RealmReplyStale) return problem(409, 'realm_reply_stale', error.message);
  if (error instanceof RealmReplyConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof RealmReplyUnavailable) return problem(503, 'realm_reply_unavailable', error.message);
  return workReadError(error);
}
function key(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

export const openApiOperations = {
  // Posting and recovery share this command; its platform gate runs before
  // either can reserve an intent. Lookup and existing thread reads stay public.
  '/v1/realms/{realm}/about-posts': { post: { exposure: 'platform:realm-reply', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realm-replies': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realm-reply-reviews': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realm-reply-placements': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/realms/{realm}/replies/{reply}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/realms/{realm}/reply-roots/{rootTarget}/count': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
} as const;

export function realmReplyRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/realms/:realm/about-posts', { params: t.Object({ realm: readUuid }), body: aboutPostBody,
      detail: { summary: 'Post to the canonical discussion about a Zone page',
        description: 'Requires comment:create, work:edit and realm:adopt Account scopes and a Person author. '
          + 'The server checks the published Zone route, current Realm attachment and observed target revision. '
          + 'It selects the opener or retained-root child and composes admitted draft, identity and placement. '
          + 'The write family debits three units in the verified principal bucket before dispatch, including retries. '
          + 'Idempotency-Key is required, limited to 128 characters and scoped to the verified principal. '
          + 'Changed input under a key returns 409. Successful retries return 200 with the same receipt body; '
          + 'pending retries resume the durable operation and 202 contains only operationId. '
          + 'Replay window: an unsettled effect can dispatch only until its Access admission expires_at; '
          + 'a settled effect replays from its immutable receipt while that receipt exists. '
          + 'Hidden and absent openers have the same outcome; the receipt contains only the poster\'s own '
          + 'Person, reply and placement, never canonical parent coordinates or an opener flag. '
          + 'Body content is limited to 8 KiB. '
          + 'This new platform:realm-reply capability stays closed pending trust-ops review.' },
      response: transportResponses(openApiOperations["/v1/realms/{realm}/about-posts"].post, { 200: aboutPostResult, 201: aboutPostResult, 202: t.Object({ operationId: uuid }, { additionalProperties: false }),
        429: problemResult(429), ...writeProblems, ...workReadProblems }, 'POST'),
    }, async ({ request, params, body }) => {
      try {
        await verifyMemberReplyDraftPrincipal(work.account, request);
        const principal = await work.account.verify(request, ['comment:create', 'work:edit', 'realm:adopt']);
        const idempotencyKey = key(request);
        if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        // The global hook debits the command's first unit. Internal owner calls
        // bypass HTTP hooks, so debit the other two in that exact principal bucket.
        if (work.rateLimit) {
          const limit = work.rateLimit;
          const principalClass = await limit.store.classify(principal);
          for (let unit = 0; unit < 2; unit++) {
            const decision = await limit.store.consume(JSON.stringify([principal.issuer, principal.subject]),
              'write', limit.budgets[principalClass].write);
            if (!decision.allowed) return problem(429, 'rate_limited', 'Request budget exhausted',
              { 'retry-after': String(decision.retryAfter) });
          }
        }
        const result = await new RealmAboutPostCommand(work).post(request, principal,
          `https://rezics.com/id/${params.realm}`, body, idempotencyKey);
        return Response.json(result.body, { ...noStore, status: result.status });
      } catch (error) { return replyError(error); }
    })
    .post('/v1/realm-replies', { body: replyBody,
      response: transportResponses(openApiOperations["/v1/realm-replies"].post, { 200: replyResult, 201: replyResult, ...writeProblems, ...workReadProblems }, 'POST') },
    async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['work:edit']);
        if (!work.realmReplies) return problem(503, 'realm_reply_unavailable', 'Realm replies are unavailable');
        const idempotencyKey = key(request);
        if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        try {
          await targetRead(work.environment, { access: work.access, principal, actingSubject: body.author }, async session => {
            if (!await readReplyRoot(session, body.rootTarget, body.rootRevision, body.contextRevision)) throw new RealmReplyDenied('Reply root is unavailable');
          });
        } catch (error) {
          if (error instanceof TargetUnavailable) throw error;
          if (error instanceof WorkReadMissing) throw new RealmReplyDenied('Reply root is unavailable');
          throw error;
        }
        const { profile: _profile, ...input } = body;
        const result = await work.realmReplies.create(principal, input, idempotencyKey,
          realmReplyDigest(body));
        return Response.json({ profile: 'realm-reply-identity-v1', ...result },
          { ...noStore, status: result.replayed ? 200 : 201 });
      } catch (error) { return replyError(error); }
    })
    .post('/v1/realm-reply-reviews', { body: reviewBody,
      response: transportResponses(openApiOperations["/v1/realm-reply-reviews"].post, { 200: reviewResult, 201: reviewResult, ...writeProblems }, 'POST') },
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
    .post('/v1/realm-reply-placements', { body: t.Union([placementBody, placementWithdrawalBody]),
      response: transportResponses(openApiOperations["/v1/realm-reply-placements"].post, { 200: t.Union([placementResult, placementWithdrawalResult]),
        201: t.Union([placementResult, placementWithdrawalResult]), ...writeProblems }, 'POST') },
    async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['realm:adopt']);
        if (!work.realmReplies) return problem(503, 'realm_reply_unavailable', 'Realm replies are unavailable');
        const idempotencyKey = key(request);
        if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        if (body.profile === 'realm-reply-placement-withdrawal-v1') {
          const { profile: _profile, actingSubject, ...input } = body;
          const result = await work.realmReplies.withdraw(principal, actingSubject,
            input, idempotencyKey, realmReplyDigest(body));
          return Response.json(result, { ...noStore, status: result.replayed ? 200 : 201 });
        }
        const { profile: _profile, actingSubject, ...input } = body;
        const result = await work.realmReplies.place(principal, actingSubject,
          input, idempotencyKey, realmReplyDigest(body));
        return Response.json({ profile: 'realm-reply-placement-v1', ...result },
          { ...noStore, status: result.replayed ? 200 : 201 });
      } catch (error) { return replyError(error); }
    })
    .get('/v1/realms/:realm/replies/:reply', {
      params: t.Object({ realm: nativePath, reply: nativePath }),
      query: t.Object({ actingSubject: native }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/realms/{realm}/replies/{reply}"].get, { 200: visibleResult, ...authorizedReadProblems, ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.realmReplies) return problem(503, 'realm_reply_unavailable', 'Realm replies are unavailable');
        const visible = await work.realmReplies.visible(nativePathIri(params.realm), nativePathIri(params.reply),
          principal, query.actingSubject);
        if (!visible) return problem(404, 'realm_reply_unavailable', 'Reply is unavailable');
        await workRead(work, request, { actingSubject: query.actingSubject }, session =>
          resolveTargets(session, [visible.rootTarget], 'discussion'));
        return Response.json({ profile: 'realm-reply-placement-v1', ...visible }, noStore);
      } catch (error) { return replyError(error); }
    })
    .get('/v1/realms/:realm/reply-roots/:rootTarget/count', {
      params: t.Object({ realm: nativePath, rootTarget: nativePath }),
      query: t.Object({ actingSubject: native }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/realms/{realm}/reply-roots/{rootTarget}/count"].get, { 200: countResult, ...authorizedReadProblems, ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.realmReplies) return problem(503, 'realm_reply_unavailable', 'Realm replies are unavailable');
        const realm = nativePathIri(params.realm), rootTarget = nativePathIri(params.rootTarget);
        const count = await workRead(work, request, { actingSubject: query.actingSubject }, async session => {
          await resolveTargets(session, [rootTarget], 'discussion');
          const result = await work.realmReplies!.rootCount(realm, rootTarget, principal, query.actingSubject);
          await resolveTargets(session, [rootTarget], 'discussion');
          return result;
        });
        return Response.json({ profile: 'realm-reply-root-count-v1', ...count }, noStore);
      } catch (error) { return replyError(error); }
    });
}
