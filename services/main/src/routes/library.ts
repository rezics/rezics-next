import { Elysia, t } from 'elysia';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { readMyShelves, readReaderStates, readStatusShelf, READER_LIBRARY_COST }
  from '../modules/library/read.ts';
import { readPublicShelves, readPublicStatusShelf } from '../modules/library/public.ts';
import { InvalidLibraryStatus, LibraryStatusConflict, StaleLibraryStatus }
  from '../modules/library/status.ts';
import { readWorkBasis } from '../modules/work/read-header.ts';
import { canonicalChapterWorks } from '../modules/structure/chapter-work.ts';
import { workRead, WorkReadInvalid } from '../modules/work/read-session.ts';
import { pageQuery, readId, readPosition, readQuery, readUuid } from '../modules/work/read-contract.ts';
import { shelfWork } from '../modules/profiles/read-contract.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { checkedOpenLibraryWorkId, fetchOpenLibraryWork } from '../modules/source/open-library.ts';
import { OpenLibraryImportSearchUnavailable, searchOpenLibraryImport }
  from '../modules/library-import/open-library-search.ts';
import { ReaderImportBudgetExceeded, ReaderImportConflict, ReaderImportInvalid, ReaderImportUnavailable }
  from '../modules/library-import/reader-import.ts';
import { importReviewedBatch } from '../modules/library-import/batch.ts';
import { readRichReadingYear } from '../modules/library/stats.ts';

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
    card: t.Nullable(shelfWork) }), { maxItems: 20 }),
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
const yearlyGoal = t.Object({ year: t.Integer({ minimum: 1900, maximum: 2100 }),
  target: t.Nullable(t.Integer({ minimum: 1, maximum: 1000 })),
  completed: t.Integer({ minimum: 0 }), version: t.Integer({ minimum: 0 }),
  changedAt: t.Nullable(t.String()), replayed: t.Optional(t.Boolean()) });
const readingStats = t.Object({ year: t.Integer({ minimum: 1900, maximum: 2100 }),
  books: t.Integer({ minimum: 0 }), chapters: t.Integer({ minimum: 0 }),
  averageRating: t.Nullable(t.Number({ minimum: 1, maximum: 5 })),
  ratedBooks: t.Integer({ minimum: 0 }), knownChapters: t.Integer({ minimum: 0 }),
  booksWithChapters: t.Integer({ minimum: 0 }),
  topConcepts: t.Array(t.Object({ name: t.String(), count: t.Integer({ minimum: 1 }) }), { maxItems: 5 }),
  titleLanguages: t.Array(t.Object({ language: t.String(), count: t.Integer({ minimum: 1 }) })),
  months: t.Array(t.Object({ month: t.Integer({ minimum: 1, maximum: 12 }),
    books: t.Integer({ minimum: 0 }), chapters: t.Integer({ minimum: 0 }) }), { minItems: 12, maxItems: 12 }) });
const privateReview = t.Object({ work: readId, text: t.String({ minLength: 1, maxLength: 8000 }),
  language: t.String(), spoiler: t.Boolean(), version: t.Integer({ minimum: 1 }),
  changedAt: t.String(), replayed: t.Optional(t.Boolean()) });
const importRow = t.Object({ work: readId, status,
  startedOn: t.Nullable(t.String({ format: 'date' })), finishedOn: t.Nullable(t.String({ format: 'date' })),
  rating: t.Nullable(t.Integer({ minimum: 1, maximum: 5 })), hasRating: t.Boolean(),
  review: t.Nullable(t.String({ maxLength: 8000 })),
  reviewVisibility: t.Union([t.Literal('private'), t.Literal('public')]),
  shelves: t.Array(t.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 }),
  conflictChoice: t.Optional(t.Union([t.Literal('keep'), t.Literal('replace')])) },
{ additionalProperties: false });
const importProgress = t.Object({ total: t.Integer({ minimum: 1, maximum: 500 }), pending: t.Boolean(),
  items: t.Array(t.Object({ index: t.Integer({ minimum: 0 }), result: t.Object({ work: readId,
    applied: t.Array(t.String()), issues: t.Array(t.String()) }) }), { maxItems: 500 }) });
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
  '/v1/me/reading-goal': { get: { bearer: true }, put: { bearer: true, idempotencyKey: true } },
  '/v1/me/reading-stats': { get: { bearer: true } },
  '/v1/me/import-reviews': { get: { bearer: true } },
  '/v1/me/import-reviews/{id}': { put: { bearer: true, idempotencyKey: true } },
  '/v1/me/library-import/batches': { post: { bearer: true, idempotencyKey: true } },
  '/v1/me/library-import/open-library': { get: { bearer: true } },
  '/v1/me/library-import/open-library/adoptions': { post: { bearer: true, idempotencyKey: true } },
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
        const parentWork = await workRead(work, request, { actingSubject: body.actingSubject },
          async session => {
            const parent = (await canonicalChapterWorks(session, [workId])).get(workId) ?? workId;
            await readWorkBasis(session, parent);
            return parent;
          });
        const result = await work.libraryStatus.write({ agent: body.actingSubject, work: parentWork,
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
    .get('/v1/me/import-reviews', {
      query: t.Object({ actingSubject: readId, works: t.String({ minLength: 1, maxLength: 1600 }) },
        { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(privateReview, { maxItems: 24 }) }), ...errors },
    }, async ({ request, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      try {
        const works = readWorks(query.works);
        if (!await reader(request, query.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library unavailable');
        return Response.json({ items: await work.libraryStatus.privateReviews(query.actingSubject, works) },
          { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .put('/v1/me/import-reviews/:id', {
      params: t.Object({ id: readUuid }),
      body: t.Object({ actingSubject: readId, text: t.String({ minLength: 1, maxLength: 8000 }),
        language: t.String({ minLength: 2, maxLength: 35 }), spoiler: t.Boolean(),
        expectedVersion: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
      response: { 200: privateReview, ...errors },
    }, async ({ request, params, body }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      const idempotencyKey = request.headers.get('idempotency-key') ?? '';
      if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      try {
        if (!await reader(request, body.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library unavailable');
        const workId = `https://rezics.com/id/${params.id}`;
        await workRead(work, request, { actingSubject: body.actingSubject },
          session => readWorkBasis(session, workId));
        return Response.json(await work.libraryStatus.putPrivateReview({ agent: body.actingSubject, work: workId,
          text: body.text, language: body.language, spoiler: body.spoiler,
          expectedVersion: body.expectedVersion, idempotencyKey }), { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .post('/v1/me/library-import/batches', {
      body: t.Object({ actingSubject: readId, context: t.Nullable(readId),
        language: t.String({ minLength: 2, maxLength: 35 }),
        existingShelves: t.Array(t.Object({ name: t.String({ minLength: 1, maxLength: 300 }),
          id: readId }), { maxItems: 100 }),
        rows: t.Array(importRow, { minItems: 1, maxItems: 500 }) }, { additionalProperties: false }),
      response: { 200: importProgress, 202: importProgress, ...errors },
    }, async ({ request, body }) => {
      if (!work.libraryImport) return problem(503, 'reader_import_unavailable', 'Reader import unavailable');
      const key = request.headers.get('idempotency-key') ?? '';
      if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      try {
        if (!await reader(request, body.actingSubject)) {
          return problem(403, 'reader_library_denied', 'Reader library unavailable');
        }
        const result = await importReviewedBatch(work.libraryImport, request, body, key);
        return Response.json(result, { status: result.pending ? 202 : 200, headers: privateHeaders });
      } catch (error) {
        if (error instanceof ReaderImportInvalid) {
          return problem(400, 'invalid_reader_import', 'Reviewed Library import is invalid');
        }
        if (error instanceof ReaderImportConflict) {
          return problem(409, 'reader_import_intent_conflict', 'Library import key changed intent');
        }
        if (error instanceof ReaderImportUnavailable) {
          return problem(503, 'reader_import_unavailable', 'Reader import is unavailable');
        }
        return commandError(error);
      }
    })
    .get('/v1/me/library-import/open-library', {
      query: t.Object({ actingSubject: readId, isbn: t.Optional(t.String({ pattern: '^\\d{13}$' })),
        title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        author: t.Optional(t.String({ maxLength: 200 })) }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(t.Object({ workId: t.String(), title: t.String(),
        authors: t.Array(t.String()), coverId: t.Nullable(t.Integer()) }), { maxItems: 6 }) }),
        ...errors, 429: problemResult(429) },
    }, async ({ request, query }) => {
      try {
        if (!await reader(request, query.actingSubject)) {
          return problem(403, 'reader_library_denied', 'Reader library unavailable');
        }
        if (!query.isbn && !query.title) return problem(400, 'invalid_request', 'Search for an ISBN or title');
        if (!work.libraryImport) return problem(503, 'reader_import_unavailable', 'Reader import unavailable');
        await work.libraryImport.takeBudget(query.actingSubject, 'search');
        return Response.json({ items: await searchOpenLibraryImport(query, work.openLibraryFetch ?? fetch) },
          { headers: privateHeaders });
      } catch (error) {
        if (error instanceof ReaderImportBudgetExceeded) {
          return problem(429, 'reader_import_search_budget', 'Search limit reached; try again tomorrow');
        }
        if (error instanceof OpenLibraryImportSearchUnavailable) {
          return problem(503, 'source_search_unavailable', 'Open Library search is unavailable');
        }
        return commandError(error);
      }
    })
    .post('/v1/me/library-import/open-library/adoptions', {
      body: t.Object({ actingSubject: readId, workId: t.String({ pattern: '^OL[1-9][0-9]{0,11}W$' }),
        titleLanguage: t.Optional(t.String({ minLength: 2, maxLength: 35 })) },
      { additionalProperties: false }),
      response: { 200: t.Object({ work: readId, replayed: t.Boolean() }),
        202: pendingOperation, ...errors, 422: problemResult(422), 429: problemResult(429) },
    }, async ({ request, body }) => {
      const key = request.headers.get('idempotency-key') ?? '';
      if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      if (!work.sourceIntake || !work.sourceConversions || !work.sourceGraph || !work.sourceProposals
        || !work.sourceAdoptions || !work.libraryImport) {
        return problem(503, 'source_unavailable', 'Source owner is unavailable');
      }
      try {
        const principal = await work.account.verify(request, ['work:read', 'work:create']);
        if (!await work.access.canReadAsBaselineMember?.(principal, body.actingSubject)) {
          return problem(403, 'reader_library_denied', 'Reader library unavailable');
        }
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const workId = checkedOpenLibraryWorkId(body.workId);
        return await work.libraryImport.withOpenLibraryWork(workId, async () => {
          let observation = await work.sourceIntake!.replay(principalId, key);
          if (observation) {
            if (observation.provider !== 'open-library' || observation.namespace !== 'work'
              || observation.externalId !== workId
              || observation.capture?.profile !== 'open-library-work-acquisition-v1') {
              return problem(409, 'source_intent_conflict', 'Import key changed Work');
            }
          }
          const existing = await work.libraryImport!.adoptedOpenLibraryWork(workId);
          if (existing) return Response.json({ work: existing, replayed: true }, { headers: privateHeaders });
          if (!observation) {
            await work.libraryImport!.takeBudget(body.actingSubject, 'acquisition');
            await work.sourceIntake!.reserveOpenLibrarySlot();
            const captured = await fetchOpenLibraryWork(workId, work.openLibraryFetch ?? fetch);
            observation = (await work.sourceIntake!.submit(principalId, key,
              captured.input, captured.capture)).observation;
          }
          const conversion = await work.sourceConversions!.convert(principalId, observation.observation.slice(-36));
          if (!conversion) return problem(503, 'source_unavailable', 'Source conversion is unavailable');
          const conversionId = conversion.conversion.conversion.slice(-36);
          await work.sourceGraph!.project(principalId, conversionId);
          const proposal = await work.sourceProposals!.propose(principalId, conversionId);
          if (!proposal) return problem(503, 'source_unavailable', 'Source proposal is unavailable');
          const adopted = await work.sourceAdoptions!.adopt(principalId, request,
            proposal.proposal.proposal.slice(-36), { actingSubject: body.actingSubject,
              authorityPath: 'represented-agent', confirmedTitle: proposal.proposal.candidateTitle,
              titleLanguage: body.titleLanguage });
          if (!adopted) return problem(503, 'source_unavailable', 'Work adoption is unavailable');
          return Response.json({ work: adopted.adoption.work, replayed: adopted.replayed },
            { headers: privateHeaders });
        });
      } catch (error) {
        if (error instanceof ReaderImportBudgetExceeded) {
          return problem(429, 'reader_import_adoption_budget', 'Book addition limit reached; try again tomorrow');
        }
        if (error instanceof ReaderImportUnavailable) {
          return problem(503, 'reader_import_unavailable', 'Reader import is temporarily unavailable');
        }
        return commandError(error);
      }
    })
    .get('/v1/me/reading-stats', {
      query: t.Object({ actingSubject: readId, year: t.Numeric({ minimum: 1900, maximum: 2100 }) },
        { additionalProperties: false }), response: { 200: readingStats, ...errors },
    }, async ({ request, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      try {
        const principal = await reader(request, query.actingSubject);
        if (!principal) return problem(403, 'reader_library_denied', 'Reader library unavailable');
        return Response.json(await readRichReadingYear(work, request, principal, query.actingSubject, query.year),
          { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .get('/v1/me/reading-goal', {
      query: t.Object({ actingSubject: readId, year: t.Numeric({ minimum: 1900, maximum: 2100 }) },
        { additionalProperties: false }), response: { 200: yearlyGoal, ...errors },
    }, async ({ request, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      try {
        if (!await reader(request, query.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library unavailable');
        return Response.json(await work.libraryStatus.goal(query.actingSubject, query.year),
          { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .put('/v1/me/reading-goal', {
      body: t.Object({ actingSubject: readId, year: t.Integer({ minimum: 1900, maximum: 2100 }),
        target: t.Nullable(t.Integer({ minimum: 1, maximum: 1000 })),
        expectedVersion: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
      response: { 200: yearlyGoal, ...errors },
    }, async ({ request, body }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      const idempotencyKey = request.headers.get('idempotency-key') ?? '';
      if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      try {
        if (!await reader(request, body.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library unavailable');
        return Response.json(await work.libraryStatus.setGoal({ agent: body.actingSubject, year: body.year,
          target: body.target, expectedVersion: body.expectedVersion, idempotencyKey }),
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
