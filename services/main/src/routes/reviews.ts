import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { ControlConflict, ControlDenied, ControlInvalid, ControlStale, ControlUnavailable }
  from '../modules/access/topology-control.ts';
import { REVIEW_COST, helpfulCommand, helpfulResult, quotePage, reviewCommand, reviewDelete,
  reviewItem as reviewItemSchema, reviewPage, reviewQuery, reviewResult } from '../modules/review/contract.ts';
import { proveReviewRating, reviewItem, reviewTarget } from '../modules/review/read.ts';
import { RatingTargetGrainMismatch } from '../modules/rating/release.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadLimit,
  WorkReadMissing, WorkReadMoved, WorkReadUnavailable, workRead } from '../modules/work/read-session.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const headers = { 'cache-control': 'private, no-store' };
const optionalBearer: { security: Record<string, string[]>[] } =
  { security: [{}, { bearerAuth: [] }] };
const param = t.Object({ id: readUuid });
const reviewErrors = { ...workReadProblems, 400: problemResult(400), 403: problemResult(403),
  409: problemResult(409), 422: problemResult(422), 503: problemResult(503) };

export const openApiOperations = {
  '/v1/reviews': { post: { bearer: true, idempotencyKey: true } },
  '/v1/reviews/{id}': { get: { bearer: false }, delete: { bearer: true, idempotencyKey: true } },
  '/v1/reviews/{id}/helpful': { put: { bearer: true, idempotencyKey: true } },
  '/v1/resources/{resource}/reviews': { get: { bearer: false } },
  '/v1/review-quotes/realms/{id}': { get: { bearer: false } },
} as const;

function reviewError(error: unknown): Response {
  if (error instanceof RatingTargetGrainMismatch) return problem(422, 'rating_target_grain_mismatch', 'Review target grain differs from the Context');
  if (error instanceof ControlInvalid) return problem(400, 'invalid_review_command', error.message);
  if (error instanceof ControlDenied) return problem(403, 'review_denied', error.message);
  if (error instanceof ControlConflict || error instanceof ControlStale) {
    return problem(409, 'review_conflict', error.message);
  }
  if (error instanceof ControlUnavailable) return problem(503, 'review_unavailable', error.message);
  return workReadError(error);
}
function boundedJson(value: unknown) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > REVIEW_COST.responseBytes) throw new WorkReadLimit('Review response exceeds its budget');
  return new Response(body, { headers: { ...headers, 'content-type': 'application/json' } });
}
function optionalReader(request: Request, actingSubject: string | undefined) {
  if (request.headers.has('authorization') !== !!actingSubject) {
    throw new ControlInvalid('Authentication and actingSubject are required together');
  }
}

export function reviewRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/reviews', { body: reviewCommand,
      response: { 200: reviewResult, 201: reviewResult, ...reviewErrors },
    }, async ({ request, body }) => {
      try {
        if (!work.reviews) throw new WorkReadUnavailable('Review owner is unavailable');
        const principal = await work.account.verify(request, ['rating:submit']);
        const key = request.headers.get('idempotency-key') ?? '';
        const result = await workRead(work, request, { actingSubject: body.actingSubject }, async session => {
          const proof = await reviewTarget(session, body.context, body.target);
          const shelf = work.libraryStatus && !proof.generic
            ? (await work.libraryStatus.batch(body.actingSubject, [body.target]))[0] : null;
          const dates = shelf?.status === 'read'
            ? { startedOn: shelf.startedOn, finishedOn: shelf.finishedOn }
            : { startedOn: null, finishedOn: null };
          const { target, ...intent } = body;
          return work.reviews!.write(principal, { ...intent, work: target }, key,
            (head, principalId) => proveReviewRating(session, principalId, body.context, target, head,
              body.rating === undefined), dates, proof);
        });
        return Response.json(result, { status: !result.replayed && body.expectedRevision === null ? 201 : 200,
          headers });
      } catch (error) { return reviewError(error); }
    })
    .delete('/v1/reviews/:id', { params: param, body: reviewDelete,
      response: { 200: reviewResult, ...reviewErrors },
    }, async ({ request, params, body }) => {
      try {
        if (!work.reviews) throw new WorkReadUnavailable('Review owner is unavailable');
        const principal = await work.account.verify(request, ['rating:submit']);
        return Response.json(await work.reviews.delete(principal, params.id, body.actingSubject,
          body.expectedRevision, request.headers.get('idempotency-key') ?? ''), { headers });
      } catch (error) { return reviewError(error); }
    })
    .put('/v1/reviews/:id/helpful', { params: param, body: helpfulCommand,
      response: { 200: helpfulResult, ...reviewErrors },
    }, async ({ request, params, body }) => {
      try {
        if (!work.reviews) throw new WorkReadUnavailable('Review owner is unavailable');
        const principal = await work.account.verify(request, ['feed:vote']);
        return Response.json(await work.reviews.helpful(principal, params.id, body.actingSubject,
          body.helpful, body.expectedRevision, request.headers.get('idempotency-key') ?? '',
          row => workRead(work, request, { actingSubject: body.actingSubject }, async session => {
            const target = await reviewTarget(session, row.context, row.work);
            if (target.mainVersion !== row.main_version || target.realm !== row.realm) {
              throw new WorkReadMoved('Review target changed');
            }
          })), { headers });
      } catch (error) { return reviewError(error); }
    })
    .get('/v1/reviews/:id', { params: param,
      query: t.Object({ actingSubject: t.Optional(readId), showSpoilers: t.Optional(t.Boolean()) },
        { additionalProperties: false }), detail: optionalBearer,
      response: { 200: reviewItemSchema, ...reviewErrors },
    }, async ({ request, params, query }) => {
      try {
        if (!work.reviews) throw new WorkReadUnavailable('Review owner is unavailable');
        optionalReader(request, query.actingSubject);
        const result = await workRead(work, request, { actingSubject: query.actingSubject }, async session => {
          const owner = session.principal ? await work.access.activePrincipalId(session.principal) : null;
          const row = await work.reviews!.byId(params.id, owner);
          if (!row) throw new WorkReadMissing('Review is unavailable');
          const target = await reviewTarget(session, row.context, row.work);
          if (target.mainVersion !== row.main_version || target.realm !== row.realm) {
            throw new WorkReadMissing('Review target is unavailable');
          }
          return reviewItem(row, query.showSpoilers ?? false);
        });
        return boundedJson(result);
      } catch (error) { return reviewError(error); }
    })
    .get('/v1/resources/:resource/reviews', { params: t.Object({ resource: readUuid }), query: reviewQuery,
      detail: optionalBearer, response: { 200: reviewPage, ...reviewErrors },
    }, async ({ request, params, query }) => {
      try {
        if (!work.reviews) throw new WorkReadUnavailable('Review owner is unavailable');
        optionalReader(request, query.actingSubject);
        const workId = `https://rezics.com/id/${params.resource}`;
        const result = await workRead(work, request, { actingSubject: query.actingSubject }, async session => {
          await reviewTarget(session, query.context, workId);
          const owner = session.principal ? await work.access.activePrincipalId(session.principal) : null;
          const generation = await work.reviews!.collectionRevision(query.context, workId);
          const binding = { context: query.context, work: workId, language: query.language ?? null,
            rating: query.rating ?? null, sort: query.sort ?? 'helpful', owner, generation };
          const cursor = decodeReadCursor(query.cursor, binding, session.position);
          let after: { count: number; time: string; id: string } | undefined;
          if (cursor?.after) {
            try { after = { ...JSON.parse(cursor.order) as { count: number; time: string }, id: cursor.after }; }
            catch { throw new WorkReadMoved('Review cursor changed'); }
          }
          const own = owner && !cursor ? await work.reviews!.own(owner, query.context, workId,
            { language: query.language, rating: query.rating }) : null;
          const slots = (query.limit ?? REVIEW_COST.pageSize) - Number(!!own);
          const rows = await work.reviews!.page({ context: query.context, work: workId,
            sort: query.sort ?? 'helpful', language: query.language, rating: query.rating,
            limit: Math.max(slots, 1), ownPrincipal: owner ?? undefined, after });
          const pageRows = rows.slice(0, slots);
          const last = pageRows.at(-1);
          const more = rows.length > slots;
          const nextCursor = more ? encodeReadCursor(binding, session.position,
            last?.id ?? '', last ? JSON.stringify({ count: last.helpful_count,
              time: last.created_at.toISOString() }) : '') : null;
          if (generation !== await work.reviews!.collectionRevision(query.context, workId)) {
            throw new WorkReadMoved('Reviews changed');
          }
          await reviewTarget(session, query.context, workId);
          return { profile: 'reader-review-page-v1' as const,
            ...pageResult(session, [...(own ? [reviewItem(own, query.showSpoilers ?? false)] : []),
              ...pageRows.map(row => reviewItem(row, query.showSpoilers ?? false))], nextCursor) };
        });
        return boundedJson(result);
      } catch (error) { return reviewError(error); }
    })
    .get('/v1/review-quotes/realms/:id', { params: param,
      query: t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: REVIEW_COST.quoteSize })),
        language: t.Optional(t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 })) },
      { additionalProperties: false }), response: { 200: quotePage, ...reviewErrors },
    }, async ({ request, params, query }) => {
      try {
        if (!work.reviews) throw new WorkReadUnavailable('Review owner is unavailable');
        const realm = `https://rezics.com/id/${params.id}`;
        const result = await workRead(work, new Request(request.url), {}, async session => {
          await session.realm(realm);
          const rows = await work.reviews!.quotes(realm, query.limit ?? REVIEW_COST.quoteSize);
          const items = [] as Array<{ review: string; work: string; context: string;
            author: string; rating: number | null; language: string; excerpt: string }>;
          for (const row of rows) {
            if (query.language && row.language !== query.language) continue;
            try {
              const target = await reviewTarget(session, row.context, row.work);
              if (target.realm !== realm || target.mainVersion !== row.main_version) continue;
            } catch (error) { if (error instanceof WorkReadMissing) continue; throw error; }
            items.push({ review: row.id, work: row.work, context: row.context,
              author: row.acting_subject, rating: row.rating,
              language: row.language, excerpt: row.body.slice(0, REVIEW_COST.excerptChars) });
          }
          return { profile: 'realm-reader-quotes-v1' as const, realm, items,
            sourcePosition: session.position };
        });
        return boundedJson(result);
      } catch (error) { return reviewError(error); }
    });
}
