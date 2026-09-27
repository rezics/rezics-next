import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { readMyShelves, readReaderStates, readStatusShelf, READER_LIBRARY_COST }
  from '../modules/library/read.ts';
import { readPublicShelves, readPublicStatusShelf } from '../modules/library/public.ts';
import { InvalidLibraryStatus, LibraryStatusConflict, StaleLibraryStatus }
  from '../modules/library/status.ts';
import { readWorkBasis } from '../modules/work/read-header.ts';
import { workRead, WorkReadInvalid } from '../modules/work/read-session.ts';
import { pageQuery, readAvatar, readId, readName, readPosition, readQuery, readUuid } from '../modules/work/read-contract.ts';
import { shelfWork } from '../modules/profiles/read-contract.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const status = t.Union([t.Literal('want-to-read'), t.Literal('reading'), t.Literal('read'), t.Null()]);
const statusState = t.Object({ work: readId, status,
  startedOn: t.Nullable(t.String({ format: 'date' })),
  finishedOn: t.Nullable(t.String({ format: 'date' })), version: t.Integer({ minimum: 0 }),
  changedAt: t.Nullable(t.String()), replayed: t.Optional(t.Boolean()) });
const customShelf = t.Object({ id: readId, name: t.String(),
  disclosure: t.Union([t.Literal('public'), t.Literal('private')]) });
const ownRating = t.Nullable(t.Object({ context: readId,
  value: t.Nullable(t.Integer({ minimum: 1, maximum: 10 })),
  availability: t.Union([t.Literal('available'), t.Literal('withdrawn')]), revision: readId, stale: t.Boolean() }));
const item = t.Object({ work: readId, status: statusState,
  customShelves: t.Array(customShelf), rating: t.Object({ global: ownRating, realm: ownRating }),
  progress: t.Nullable(t.Object({ structure: readId, occurrence: readId,
    selectedRevision: t.Nullable(t.String()), completed: t.Boolean(), position: t.Nullable(t.String()),
    version: t.Integer(), changedAt: t.String() })) });
const batch = t.Object({ profile: t.Literal('reader-work-state-batch-v1'),
  items: t.Array(item, { maxItems: 24 }), sourcePosition: readPosition });
const single = t.Object({ profile: t.Literal('reader-work-state-v1'), ...item.properties,
  sourcePosition: readPosition });
const shelf = t.Object({ id: readId, revision: readId, name: t.String(),
  kind: t.Union([t.Literal('static'), t.Literal('captured')]),
  disclosure: t.Union([t.Literal('public'), t.Literal('private')]),
  structure: readId, changedSequence: t.String() });
const shelves = t.Object({ profile: t.Literal('reader-shelves-v1'),
  statusShelves: t.Array(t.Object({ status: t.Exclude(status, t.Null()),
    count: t.Integer({ minimum: 0 }), changedAt: t.Nullable(t.String()) }), { maxItems: 3 }),
  items: t.Array(shelf, { maxItems: 20 }), nextCursor: t.Nullable(t.String()),
  sourcePosition: readPosition,
  count: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Literal('exact-page'), total: t.Null() }) });
const statusShelf = t.Object({ profile: t.Literal('reader-status-shelf-v1'),
  status: t.Exclude(status, t.Null()), items: t.Array(t.Object({ ...statusState.properties,
    card: t.Nullable(t.Object({ id: readId, title: readName, cover: readAvatar })) }), { maxItems: 20 }),
  nextCursor: t.Nullable(t.String()), sourcePosition: readPosition,
  count: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Literal('exact-page'), total: t.Null() }) });
const publicShelves = t.Object({ profile: t.Literal('agent-status-shelves-v1'), agent: readId,
  statusShelves: t.Array(t.Object({ status: t.Exclude(status, t.Null()),
    count: t.Integer({ minimum: 0 }), changedAt: t.Nullable(t.String()) }), { maxItems: 3 }),
  sourcePosition: readPosition });
const publicStatusShelf = t.Object({ profile: t.Literal('agent-status-shelf-v1'), agent: readId,
  status: t.Exclude(status, t.Null()), statusCount: t.Integer({ minimum: 0 }),
  items: t.Array(t.Object({ work: readId, card: shelfWork }), { maxItems: 20 }),
  nextCursor: t.Nullable(t.String()), sourcePosition: readPosition,
  count: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Literal('exact-page'), total: t.Null() }) });
const errors = { 400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
  404: problemResult(404), 409: problemResult(409), 500: problemResult(500), 503: problemResult(503) };
const privateHeaders = { 'cache-control': 'private, no-store' };
const publicHeaders = { 'cache-control': 'public, max-age=60' };

export const openApiOperations = {
  '/v1/works/{id}/reader-state': { get: { bearer: false } },
  '/v1/me/work-states': { get: { bearer: false } },
  '/v1/works/{id}/reader-status': { put: { bearer: true, idempotencyKey: true } },
  '/v1/me/shelves': { get: { bearer: true } },
  '/v1/me/shelves/status/{status}/works': { get: { bearer: true } },
  '/v1/agents/{id}/shelves': { get: { bearer: false } },
  '/v1/agents/{id}/shelves/status/{status}/works': { get: { bearer: false } },
} as const;

function failure(error: unknown) {
  if (error instanceof InvalidLibraryStatus || error instanceof WorkReadInvalid) {
    return problem(400, 'invalid_reader_library', error.message);
  }
  if (error instanceof StaleLibraryStatus) return problem(409, 'stale_reader_status', error.message);
  if (error instanceof LibraryStatusConflict) return problem(409, 'reader_status_conflict', error.message);
  return workReadError(error);
}

function empty(works: string[], one = false) {
  const result = { profile: 'reader-work-state-batch-v1',
    items: works.map(work => ({ work, status: { work, status: null, startedOn: null,
      finishedOn: null, version: 0, changedAt: null }, customShelves: [],
      rating: { global: null, realm: null }, progress: null })),
    sourcePosition: { dataEpoch: '', sequence: '' } };
  return Response.json(one ? { profile: 'reader-work-state-v1', ...result.items[0],
    sourcePosition: result.sourcePosition } : result, { headers: publicHeaders });
}

function readWorks(value: string) {
  const works = value.split(',');
  if (!works.length || works.length > READER_LIBRARY_COST.batchWorks
    || new Set(works).size !== works.length
    || works.some(work => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work))) {
    throw new WorkReadInvalid('Request one to 24 unique Work IDs');
  }
  return works;
}

export function libraryRoutes(work: MainWorkDependencies) {
  const reader = async (request: Request, agent: string) => {
    const principal = await work.account.verify(request, ['work:read']);
    if (!work.access.canReadAsBaselineMember
      || !await work.access.canReadAsBaselineMember(principal, agent)) return null;
    return principal;
  };
  return new Elysia()
    .get('/v1/works/:id/reader-state', { params: t.Object({ id: readUuid }),
      query: t.Object({ actingSubject: t.Optional(readId), realm: t.Optional(readId) }, { additionalProperties: false }),
      response: { 200: single, ...workReadProblems },
    }, async ({ request, params, query }) => {
      const workId = `https://rezics.com/id/${params.id}`;
      if (!request.headers.has('authorization')) return empty([workId], true);
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library is unavailable');
      if (!query.actingSubject) return problem(400, 'acting_subject_required', 'actingSubject is required');
      try {
        if (!await reader(request, query.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library is unavailable');
        const result = await workRead(work, request, query,
          session => readReaderStates(session, query.actingSubject!, [workId], work.libraryStatus!, query.realm));
        return Response.json({ profile: 'reader-work-state-v1', ...result.items[0],
          sourcePosition: result.sourcePosition }, { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .get('/v1/me/work-states', { query: t.Object({ works: t.String({ minLength: 1, maxLength: 1600 }),
      actingSubject: t.Optional(readId), realm: t.Optional(readId) }, { additionalProperties: false }),
      response: { 200: batch, ...workReadProblems },
    }, async ({ request, query }) => {
      let works: string[];
      try { works = readWorks(query.works); } catch (error) { return failure(error); }
      if (!request.headers.has('authorization')) return empty(works);
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library is unavailable');
      if (!query.actingSubject) return problem(400, 'acting_subject_required', 'actingSubject is required');
      try {
        if (!await reader(request, query.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library is unavailable');
        return Response.json(await workRead(work, request, query,
          session => readReaderStates(session, query.actingSubject!, works, work.libraryStatus!, query.realm)),
        { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .put('/v1/works/:id/reader-status', { params: t.Object({ id: readUuid }),
      body: t.Object({ actingSubject: readId, expectedVersion: t.Integer({ minimum: 0 }),
        status, startedOn: t.Nullable(t.String({ format: 'date' })),
        finishedOn: t.Nullable(t.String({ format: 'date' })) }, { additionalProperties: false }),
      response: { 200: statusState, ...errors },
    }, async ({ request, params, body }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library is unavailable');
      const idempotencyKey = request.headers.get('idempotency-key') ?? '';
      if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      try {
        if (!await reader(request, body.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library is unavailable');
        const workId = `https://rezics.com/id/${params.id}`;
        await workRead(work, request, { actingSubject: body.actingSubject },
          session => readWorkBasis(session, workId));
        const result = await work.libraryStatus.write({ agent: body.actingSubject, work: workId,
          status: body.status, startedOn: body.startedOn, finishedOn: body.finishedOn,
          expectedVersion: body.expectedVersion, idempotencyKey });
        return Response.json(result, { headers: privateHeaders });
      } catch (error) {
        if (error instanceof InvalidLibraryStatus || error instanceof StaleLibraryStatus
          || error instanceof LibraryStatusConflict) return failure(error);
        return commandError(error);
      }
    })
    .get('/v1/me/shelves', { query: t.Object({ actingSubject: readId,
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20 })),
      cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) }, { additionalProperties: false }),
      response: { 200: shelves, ...workReadProblems },
    }, async ({ request, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library is unavailable');
      try {
        if (!await reader(request, query.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library is unavailable');
        return Response.json(await workRead(work, request, query,
          session => readMyShelves(session, query.actingSubject, work.libraryStatus!)),
        { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .get('/v1/me/shelves/status/:status/works', { params: t.Object({ status: t.Exclude(status, t.Null()) }),
      query: t.Object({ actingSubject: readId,
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20 })),
        cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) },
      { additionalProperties: false }), response: { 200: statusShelf, ...workReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library is unavailable');
      try {
        if (!await reader(request, query.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library is unavailable');
        return Response.json(await workRead(work, request, query,
          session => readStatusShelf(session, query.actingSubject, work.libraryStatus!, params.status)),
        { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .get('/v1/agents/:id/shelves', { params: t.Object({ id: readUuid }),
      query: t.Object(readQuery, { additionalProperties: false }),
      response: { 200: publicShelves, ...workReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      try {
        return Response.json(await workRead(work, request, query,
          session => readPublicShelves(session, `https://rezics.com/id/${params.id}`, work.libraryStatus!)),
        { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .get('/v1/agents/:id/shelves/status/:status/works', {
      params: t.Object({ id: readUuid, status: t.Exclude(status, t.Null()) }),
      query: t.Object(pageQuery, { additionalProperties: false }),
      response: { 200: publicStatusShelf, ...workReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      try {
        return Response.json(await workRead(work, request, query,
          session => readPublicStatusShelf(session, `https://rezics.com/id/${params.id}`,
            work.libraryStatus!, params.status)), { headers: privateHeaders });
      } catch (error) { return failure(error); }
    });
}
