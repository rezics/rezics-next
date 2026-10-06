import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { contentDraftWriteResult, readProblems, writeProblems } from '../api-responses.ts';
import { saveMemberReplyDraft } from '../modules/content-publication/reply-draft.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import { documentSnapshotSchema } from '../api-document.ts';
import type { DocumentSnapshot } from '@rezics/document';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f-]{36}$' });
const reply = t.Object({ reply: native, author: native, rootTarget: native, rootRevision: native,
  originRealm: t.Optional(t.Nullable(native)), spoiler: t.Optional(t.Boolean()),
  variantId: t.String(), revisionId: uuid, body: t.String(), document: t.Optional(documentSnapshotSchema), revisionDigest: t.String(),
  parentReply: t.Optional(t.Nullable(native)), parentRevision: t.Optional(t.Nullable(uuid)) });
export const openApiOperations = {
  '/v1/member-reply-drafts': { post: { bearer: true, idempotencyKey: true } },
} as const;
const draftFields = { profile: t.Literal('member-reply-draft-v1'), reply: native,
  variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
  rootTarget: native, rootRevision: native, language: t.String({ minLength: 2, maxLength: 35 }),
  originRealm: t.Optional(t.Nullable(native)), spoiler: t.Optional(t.Boolean()),
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl'), t.Literal('none')]),
  expectedHead: t.Nullable(uuid), actingSubject: native };

export function memberReplyRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/member-reply-drafts', {
      body: t.Union([
        t.Object({ ...draftFields, body: t.Nullable(t.String({ minLength: 1, maxLength: 8192 })) }, { additionalProperties: false }),
        t.Object({ ...draftFields, document: documentSnapshotSchema }, { additionalProperties: false }),
      ]),
      response: { 200: t.Object({ reply: native, variantId: t.String(), revisionId: uuid, revisionDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
        predecessor: t.Nullable(uuid), deleted: t.Boolean(), sourcePosition: contentDraftWriteResult.properties.sourcePosition,
        replayed: t.Boolean() }),
      201: t.Object({ reply: native, variantId: t.String(), revisionId: uuid, revisionDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
        predecessor: t.Nullable(uuid), deleted: t.Boolean(), sourcePosition: contentDraftWriteResult.properties.sourcePosition,
        replayed: t.Boolean() }), ...writeProblems, ...workReadProblems, 413: problemResult(413) },
    }, async ({ request, body }) => {
      try {
        const key = request.headers.get('idempotency-key');
        if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        if (!work.contentAuthoring) return problem(503, 'content_unavailable', 'Content authoring is unavailable');
        const saved = await saveMemberReplyDraft(work.environment, work.contentAuthoring,
          work.account, work.access, request, { ...body,
            ...('document' in body ? { document: body.document as DocumentSnapshot } : {}) }, key);
        return Response.json(saved, { status: saved.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return workReadError(error); }
    })
    .get('/v1/member-replies/:reply', { params: t.Object({ reply: uuid }),
      query: t.Object({ actingSubject: t.Optional(native) }),
      response: { 200: reply, ...readProblems } }, async ({ params, request, query }) => {
      try {
        if (!work.realmReplies) return problem(503, 'reply_unavailable', 'Replies are unavailable');
        const principal = request.headers.has('authorization') ? await work.account.verify(request, ['work:read']) : undefined;
        const result = await work.realmReplies.readPublic(`https://rezics.com/id/${params.reply}`, principal, query.actingSubject);
        return result ? Response.json(result, { headers: { 'cache-control': 'no-store' } })
          : problem(404, 'reply_unavailable', 'Reply is unavailable');
      } catch (error) { return workReadError(error); }
    })
    .get('/v1/member-replies', {
      query: t.Object({ rootTarget: native, rootRevision: native, after: t.Optional(native),
        realm: t.Optional(native), actingSubject: t.Optional(native) }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(reply, { maxItems: 32 }), next: t.Nullable(native) }), ...readProblems },
    }, async ({ request, query }) => {
      try {
        if (!work.realmReplies) return problem(503, 'reply_unavailable', 'Replies are unavailable');
        const principal = request.headers.has('authorization') ? await work.account.verify(request, ['work:read']) : undefined;
        const result = await work.realmReplies.listPublic(query.rootTarget, query.rootRevision, query.after,
          query.realm, principal, query.actingSubject);
        return result ? Response.json(result, { headers: { 'cache-control': 'no-store' } })
          : problem(404, 'reply_unavailable', 'Reply root is unavailable');
      } catch (error) { return workReadError(error); }
    });
}
