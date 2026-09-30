import { Elysia, t } from 'elysia';
import { ContentCommentInvalid, resolveParagraphSelector } from '../../../content/src/comments.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { editAdmittedMetadataWork } from '../modules/work/edit-admitted.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri } from '../modules/work/activate.ts';
import { ContentDraftStale, saveAdmittedContentDraft } from '../modules/content-publication/draft.ts';
import { createAdmittedContentComment } from '../modules/content-publication/comment.ts';
import { EmptyContentPublicationBody } from '../modules/content-publication/publish.ts';
import { publishAdmittedContent } from '../modules/content-publication/publish-admitted.ts';
import { selectAdmittedPublicContentSearch }
  from '../modules/content-publication/eligibility-admitted.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, contentCommentPageResult, contentCommentResult,
  contentDraftWriteResult, contentEditWriteResult, contentEligibilityWriteResult,
  contentPublicationWriteResult, exactContentRevision, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { titleControlBasis } from './shared.ts';
import { publicDomainRevisionCurrent } from '../modules/content-publication/public-domain-read.ts';

const textDraftFields = {
  resourceId: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
  variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
  language: t.Object({ kind: t.Literal('tag'), tag: t.String(),
    originalTag: t.String() }, { additionalProperties: false }),
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl'), t.Literal('none')]),
  expectedHead: t.Union([t.String({ pattern: '^[0-9a-f-]{36}$' }), t.Null()]),
  body: t.String({ maxLength: 65536 }),
  embeds: t.Optional(t.Array(t.String({
    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  }), { maxItems: 16 })),
  actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
};
const publicDomainSource = t.Object({ provider: t.String({ minLength: 1, maxLength: 100 }),
  identifier: t.String({ minLength: 1, maxLength: 300 }),
  url: t.String({ pattern: '^https://[^\\s]+$', maxLength: 2048 }),
  byteDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
  retrievedAt: t.String({ format: 'date-time' }),
}, { additionalProperties: false });
const eligibilityFields = {
  resourceId: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
  variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
  publicationDecision: t.String(), expectedEligibilityHead: t.Nullable(t.String()),
  actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
  disclosure: t.Literal('public'),
};

export function contentRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/content-drafts', {
      body: t.Union([
        t.Object({ profile: t.Literal('content-text-v1'), ...textDraftFields },
          { additionalProperties: false }),
        t.Object({ profile: t.Literal('content-public-domain-text-v1'), ...textDraftFields,
          assessmentId: t.String({ pattern: '^[0-9a-f-]{36}$' }), source: publicDomainSource },
        { additionalProperties: false }),
      ]),
      response: { 200: contentDraftWriteResult, 201: contentDraftWriteResult,
        ...writeProblems, 413: problemResult(413) },
    }, async ({ request, body }) => {
      if (!work.contentAuthoring || body.profile === 'content-public-domain-text-v1' && !work.rights?.store) {
        return problem(503, 'content_unavailable', 'Content authoring or rights owner is unavailable');
      }
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const saved = await saveAdmittedContentDraft(work.environment,
          work.contentAuthoring, work.account, work.access, request,
          { resourceId: body.resourceId,
            variant: { id: body.variantId, resourceId: body.resourceId,
              language: body.language, direction: body.direction },
            expectedHead: body.expectedHead, body: body.body,
            embeds: body.embeds,
            actingSubject: body.actingSubject, idempotencyKey,
            ...(body.profile === 'content-public-domain-text-v1' ? {
              publicDomain: { assessmentId: body.assessmentId, source: body.source },
            } : {}) }, work.rights?.store);
        return Response.json({ resourceId: body.resourceId, variantId: body.variantId,
          revisionId: saved.revisionId, predecessor: saved.predecessor,
          byteDigest: saved.byteDigest,
          sourcePosition: saved.position, replayed: saved.replayed }, {
          status: saved.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        if (error instanceof ContentDraftStale) return Response.json({
          type: 'https://rezics.com/problems/stale_head', title: error.message,
          status: 409, code: 'stale_head', currentHead: error.currentHead,
        }, { status: 409, headers: { 'cache-control': 'no-store' } });
        return commandError(error);
      }
    })
    .post('/v1/content-comments', {
      body: t.Object({ profile: t.Literal('content-paragraph-comment-v1'),
        resourceId: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        revisionId: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        exact: t.String({ minLength: 1, maxLength: 4096 }),
        body: t.String({ minLength: 1, maxLength: 8192 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contentCommentResult, 201: contentCommentResult,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      if (!work.comments) return problem(503, 'content_unavailable', 'Comment owner is unavailable');
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const comment = await createAdmittedContentComment(work.environment,
          work.comments, work.account, work.access, request, {
            resourceId: body.resourceId, revisionId: body.revisionId,
            exact: body.exact, body: body.body,
            author: body.actingSubject, idempotencyKey });
        return Response.json(comment, { status: comment.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/content-comments/:comment', {
      params: t.Object({ comment: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: contentCommentResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.comments || !work.content) {
          return problem(503, 'content_unavailable', 'Comment or Content owner is unavailable');
        }
        const comment = await work.comments.read(params.comment);
        if (!comment || !await work.access.canReadWork(principal, query.actingSubject,
          comment.resourceId)) {
          return problem(404, 'comment_unavailable', 'Comment is unavailable');
        }
        const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
          ASK { GRAPH <urn:rezics:graph:current> {
            ${iri(comment.resourceId)} a schema:CreativeWork } }`);
        if (current.boolean !== true) return problem(404, 'comment_unavailable', 'Comment is unavailable');
        const exact = (await work.content.readExactBatch([comment.revisionId],
          async ids => new Set(ids)))[0];
        if (exact?.status !== 'available' || exact.reference.resourceId !== comment.resourceId
          || exact.reference.variantId !== comment.variantId
          || exact.reference.byteDigest !== comment.byteDigest) {
          return problem(503, 'revision_unavailable', 'Comment source bytes are unavailable');
        }
        if (!await publicDomainRevisionCurrent(exact.reference, work.rights?.store)) {
          return problem(404, 'comment_unavailable', 'Comment is unavailable');
        }
        const text = exact.body.body;
        const selector = comment.target.selector;
        try {
          if (typeof text !== 'string') throw new ContentCommentInvalid('source has no text body');
          const resolved = resolveParagraphSelector(text, selector.exact);
          if (resolved.prefix !== selector.prefix || resolved.suffix !== selector.suffix) {
            throw new ContentCommentInvalid('stored selector context differs');
          }
        } catch (error) {
          if (!(error instanceof ContentCommentInvalid)) throw error;
          return problem(503, 'revision_unavailable', 'Comment selector no longer resolves');
        }
        return Response.json({ ...comment, resolvedText: selector.exact },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/content-revisions/:revision/comments', {
      params: t.Object({ revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }), pageSize: t.Optional(t.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
      cursor: t.Optional(t.String({ pattern: '^[A-Za-z0-9_-]{1,512}$' })),
      }, { additionalProperties: false }),
      response: { 200: contentCommentPageResult,
        ...authorizedReadProblems, 409: problemResult(409), 422: problemResult(422) },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.comments || !work.content) {
          return problem(503, 'content_unavailable', 'Comment or Content owner is unavailable');
        }
        const resourceId = await work.content.owningResourceForRevision(params.revision);
        if (!resourceId || !await work.access.canReadWork(principal, query.actingSubject,
          resourceId)) return problem(404, 'comment_unavailable', 'Comments are unavailable');
        const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
          ASK { GRAPH <urn:rezics:graph:current> {
            ${iri(resourceId)} a schema:CreativeWork } }`);
        if (current.boolean !== true) return problem(404, 'comment_unavailable', 'Comments are unavailable');
        let page;
        try {
          page = await work.comments.list(params.revision,
            query.pageSize ? Number(query.pageSize) : 50, query.cursor);
        } catch (error) {
          if (error instanceof ContentCommentInvalid) {
            return problem(400, 'invalid_comment_page', 'Comment page request is invalid');
          }
          throw error;
        }
        const exact = (await work.content.readExactBatch([params.revision],
          async ids => new Set(ids)))[0];
        if (exact?.status !== 'available' || exact.reference.resourceId !== resourceId) {
          return problem(503, 'revision_unavailable', 'Comment source bytes are unavailable');
        }
        if (!await publicDomainRevisionCurrent(exact.reference, work.rights?.store)) {
          return problem(404, 'comment_unavailable', 'Comments are unavailable');
        }
        const text = exact.body.body;
        if (typeof text !== 'string') {
          return problem(503, 'revision_unavailable', 'Comment source text is unavailable');
        }
        const comments = [];
        for (const comment of page.comments) {
          if (comment.resourceId !== resourceId
            || comment.variantId !== exact.reference.variantId
            || comment.byteDigest !== exact.reference.byteDigest) {
            return problem(503, 'revision_unavailable', 'Comment source bytes are unavailable');
          }
          const selector = comment.target.selector;
          try {
            const resolved = resolveParagraphSelector(text, selector.exact);
            if (resolved.prefix !== selector.prefix || resolved.suffix !== selector.suffix) {
              throw new ContentCommentInvalid('stored selector context differs');
            }
          } catch (error) {
            if (!(error instanceof ContentCommentInvalid)) throw error;
            return problem(503, 'revision_unavailable', 'Comment selector no longer resolves');
          }
          comments.push({ ...comment, resolvedText: selector.exact });
        }
        const payload = { ...page, comments };
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 1_048_576) {
          return problem(422, 'comment_page_budget_exceeded',
            'Comment page is too large; request fewer comments');
        }
        return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/content-publications', {
      body: t.Object({ profile: t.Literal('content-publication-v1'),
        targetProfile: t.Optional(t.Literal('catalog-description-v1')),
        preparationId: t.String({ minLength: 1, maxLength: 200 }),
        revisionId: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        expectedDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
        expectedContentEpoch: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        resourceId: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
        expectedPublicationHead: t.Nullable(t.String()),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contentPublicationWriteResult, 201: contentPublicationWriteResult,
        202: contentPublicationWriteResult, ...writeProblems,
        404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, body }) => {
      if (!work.contentAuthoring) return problem(503, 'content_unavailable', 'Content owner is unavailable');
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const { profile: _profile, targetProfile, ...input } = body;
        const result = await publishAdmittedContent(work.environment, work.contentAuthoring,
          work.account, work.access, request, { ...input,
            ...(targetProfile ? { targetProfile: 'catalog-description' as const } : {}), idempotencyKey });
        return Response.json(result, { status: result.status === 'pending' ? 202
          : result.replayed || result.status === 'rejected' ? 200 : 201,
        headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof EmptyContentPublicationBody) return problem(422, 'empty_body', error.message);
        return commandError(error);
      }
    })
    .post('/v1/content-search-eligibility', {
      body: t.Union([
        t.Object({ profile: t.Literal('content-search-eligibility-v1'), ...eligibilityFields,
          rightsBasis: t.Literal('original-contribution') }, { additionalProperties: false }),
        t.Object({ profile: t.Literal('content-search-eligibility-v2'), ...eligibilityFields,
          rightsBasis: t.Literal('public-domain'),
          assessmentId: t.String({ pattern: '^[0-9a-f-]{36}$' }) }, { additionalProperties: false }),
      ]),
      response: { 200: contentEligibilityWriteResult, 201: contentEligibilityWriteResult,
        ...writeProblems },
    }, async ({ request, body }) => {
      if (!work.contentAuthoring || !work.access.verifyContentDraftProof
        || body.profile === 'content-search-eligibility-v2' && !work.rights?.store) {
        return problem(503, 'content_unavailable', 'Content owner or draft proof is unavailable');
      }
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const { profile, ...input } = body;
        const result = await selectAdmittedPublicContentSearch(work.environment,
          work.contentAuthoring, work.account,
          work.access as Required<MainWorkDependencies['access']>, request,
          { ...input, ...(profile === 'content-search-eligibility-v2' ? { profile } : {}),
            idempotencyKey }, work.rights?.store);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/content-edits', {
      body: t.Object({ titleControl: t.Optional(titleControlBasis),
        profile: t.Literal('metadata-only-v1'),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        title: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: contentEditWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await editAdmittedMetadataWork(work.environment, work.account, work.access,
          request, { work: body.work, expectedHead: body.expectedHead, title: body.title,
            actingSubject: body.actingSubject, idempotencyKey, titleControl: body.titleControl });
        return Response.json({ work: receipt.work, revision: receipt.revision,
          predecessor: receipt.predecessor,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, {
          status: 200, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return commandError(error);
      }
    })
    .get('/v1/content-revisions/:revision', {
      params: t.Object({ revision: t.String({
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: exactContentRevision, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        if (!work.content) return problem(503, 'dependency_unavailable', 'Content owner is unavailable');
        const resourceId = await work.content.owningResourceForRevision(params.revision);
        if (!resourceId || !await work.access.canReadWork(principal, query.actingSubject, resourceId)) {
          return problem(404, 'revision_unavailable', 'Revision is unavailable');
        }
        const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
          ASK { GRAPH <urn:rezics:graph:current> { ${iri(resourceId)} a schema:CreativeWork } }`);
        if (current.boolean !== true) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        if (await work.governance?.store.restrictedContentRevision(resourceId, params.revision)) {
          return problem(404, 'revision_unavailable', 'Revision is unavailable');
        }
        const exact = (await work.content.readExactBatch([params.revision],
          async ids => new Set(ids)))[0];
        if (exact?.status === 'available'
          && await publicDomainRevisionCurrent(exact.reference, work.rights?.store)) {
          return Response.json({ reference: exact.reference, serializedJson: exact.serializedJson,
            body: exact.body }, { headers: { 'cache-control': 'no-store' } });
        }
        if (exact?.status === 'corrupt' || exact?.status === 'unavailable') {
          return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
        }
        return problem(404, 'revision_unavailable', 'Revision is unavailable');
      } catch (error) {
        return commandError(error);
      }
    });
}
