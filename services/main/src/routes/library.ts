import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { readMyShelves, readReaderStates, readStatusShelf, READER_LIBRARY_COST }
  from '../modules/library/read.ts';
import { readPublicShelves, readPublicStatusShelf } from '../modules/library/public.ts';
import { ShelfCandidateBudget } from '../modules/library/shelf-page.ts';
import { InvalidLibraryStatus, LibraryStatusConflict, StaleLibraryStatus }
  from '../modules/library/status.ts';
import { readWorkBasis } from '../modules/work/read-header.ts';
import { resolveLibraryWork, resolveLibraryWorks } from '../modules/library/resolve-work.ts';
import { workRead, WorkReadInvalid } from '../modules/work/read-session.ts';
import { pageQuery, readId, readPosition, readQuery, readUuid } from '../modules/work/read-contract.ts';
import { shelfWork } from '../modules/profiles/read-contract.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { readRichReadingYear } from '../modules/library/stats.ts';
import { resourceListing } from '../modules/realm-admin/contract.ts';
import { pageDiscovery } from '../modules/realm-reads/read-contract.ts';
import { pageDiscoveryHeaders, pageDiscoveryPolicy } from '../modules/space/visibility.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../modules/work/read-session.ts';

const shelfSort = t.Optional(t.Union([t.Literal('added'), t.Literal('title'), t.Literal('rating'),
  t.Literal('last-read'), t.Literal('finished')]));
const publicShelfSort = t.Optional(t.Union([t.Literal('added'), t.Literal('title')]));
const shelfOrder = t.Optional(t.Union([t.Literal('asc'), t.Literal('desc')]));
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
  listing: resourceListing, discovery: pageDiscovery,
  statusShelves: t.Array(t.Object({ status: t.Exclude(status, t.Null()),
    count: t.Integer({ minimum: 0, description: 'Visible Works counted in the bounded prefix.' }),
    countKind: t.Union([t.Literal('exact'), t.Literal('lower-bound'), t.Literal('approximate')], {
      description: 'Show N+ while continuing, about N after a multi-page walk, with countBasis. Counts may lag disclosure changes; only a complete single-page read is exact.' }),
    countBasis: t.String({ format: 'date-time', description: 'Start time of the count walk, preserved by its continuation.' }),
    changedAt: t.Nullable(t.String()), nextCursor: t.Nullable(t.String({
      description: 'Continue this count through the public status shelf Works endpoint using default sort and order.' })) }), { maxItems: 3 }),
  sourcePosition: readPosition });
const publicStatusShelf = t.Object({ profile: t.Literal('agent-status-shelf-v1'), agent: readId,
  listing: resourceListing, discovery: pageDiscovery,
  status: t.Exclude(status, t.Null()), statusCount: t.Integer({ minimum: 0,
    description: 'Cumulative visible Works delivered in this traversal; the cursor resumes counting.' }),
  statusCountKind: t.Union([t.Literal('exact'), t.Literal('lower-bound'), t.Literal('approximate')], {
    description: 'Show N+ while continuing, about N after a multi-page walk, with statusCountBasis. Counts may lag disclosure changes; only a complete single-page read is exact. Empty pages can continue.' }),
  statusCountBasis: t.String({ format: 'date-time', description: 'Start time of the count walk, preserved across pages.' }),
  items: t.Array(t.Object({ work: readId, card: shelfWork }), { maxItems: 20 }),
  nextCursor: t.Nullable(t.String()), sourcePosition: readPosition,
  count: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Literal('exact-page'), total: t.Null() }) });
const yearlyGoal = t.Object({ year: t.Integer({ minimum: 1900, maximum: 2100 }),
  target: t.Nullable(t.Integer({ minimum: 1, maximum: 1000 })),
  completed: t.Integer({ minimum: 0 }), version: t.Integer({ minimum: 0 }),
  changedAt: t.Nullable(t.String()), replayed: t.Optional(t.Boolean()) });
const readingStats = t.Object({ detailsAvailability: t.Union([t.Literal('complete'), t.Literal('unavailable')]), year: t.Integer({ minimum: 1900, maximum: 2100 }),
  books: t.Integer({ minimum: 0 }), chapters: t.Integer({ minimum: 0 }),
  averageRating: t.Nullable(t.Number({ minimum: 1, maximum: 5 })),
  ratedBooks: t.Nullable(t.Integer({ minimum: 0 })), knownChapters: t.Nullable(t.Integer({ minimum: 0 })),
  booksWithChapters: t.Nullable(t.Integer({ minimum: 0 })),
  topConcepts: t.Nullable(t.Array(t.Object({ name: t.String(), count: t.Integer({ minimum: 1 }) }), { maxItems: 5 })),
  titleLanguages: t.Nullable(t.Array(t.Object({ language: t.String(), count: t.Integer({ minimum: 1 }) }))),
  months: t.Array(t.Object({ month: t.Integer({ minimum: 1, maximum: 12 }),
    books: t.Integer({ minimum: 0 }), chapters: t.Integer({ minimum: 0 }) }), { minItems: 12, maxItems: 12 }) });
const privateReview = t.Object({ work: readId, text: t.String({ minLength: 1, maxLength: 8000 }),
  language: t.String(), spoiler: t.Boolean(), version: t.Integer({ minimum: 1 }),
  changedAt: t.String(), replayed: t.Optional(t.Boolean()) });
const errors = { 400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
  404: problemResult(404), 409: problemResult(409), 500: problemResult(500), 503: problemResult(503) };
const privateHeaders = { 'cache-control': 'private, no-store' };
const publicHeaders = { 'cache-control': 'public, max-age=60' };

/** Two Access listing point reads fence the signals with the shelf read. The
 * shelf owner separately fences profile/library visibility and its inventory. */
async function publicShelfResponse(work: MainWorkDependencies, request: Request,
  options: Parameters<typeof workRead>[2], agent: string,
  read: (session: WorkReadSession, budget: ShelfCandidateBudget) => Promise<object>) {
  const budget = new ShelfCandidateBudget();
  const result = await workRead(work, request, options, async session => {
    if (!work.profiles) throw new WorkReadUnavailable('Profile owner unavailable');
    const listing = await work.profiles.listing.read(agent);
    const value = await read(session, budget);
    if ((await work.profiles.listing.read(agent)).version !== listing.version) {
      throw new WorkReadMoved('Agent listing changed');
    }
    return { ...value, listing: listing.listing, discovery: pageDiscoveryPolicy('public', listing.listing) };
  });
  return Response.json(result, { headers: { ...privateHeaders, ...pageDiscoveryHeaders(result.discovery) } });
}

export const openApiOperations = {
  '/v1/works/{id}/reader-state': { get: { exposure: 'public', bearer: false } },
  '/v1/me/work-states': { get: { exposure: 'public', bearer: false } },
  '/v1/works/{id}/reader-status': { put: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/me/shelves': { get: { exposure: 'public', bearer: true } },
  '/v1/me/shelves/status/{status}/works': { get: { exposure: 'public', bearer: true } },
  '/v1/agents/{id}/shelves': { get: { exposure: 'public', bearer: false } },
  '/v1/agents/{id}/shelves/status/{status}/works': { get: { exposure: 'public', bearer: false } },
  '/v1/me/reading-goal': { get: { exposure: 'public', bearer: true }, put: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/me/reading-stats': { get: { exposure: 'public', bearer: true } },
  '/v1/me/import-reviews': { get: { exposure: 'public', bearer: true } },
  '/v1/me/import-reviews/{id}': { put: { exposure: 'public', bearer: true, idempotencyKey: true } },
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
        status, startedOn: t.Optional(t.Nullable(t.String({ format: 'date' }))),
        finishedOn: t.Optional(t.Nullable(t.String({ format: 'date' }))) }, { additionalProperties: false }),
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
        const basis = await workRead(work, request, { actingSubject: body.actingSubject },
          async session => {
            const book = await resolveLibraryWork(session, workId);
            const basis = await readWorkBasis(session, book);
            return { work: book, title: basis.card.title.value };
          });
        const result = await work.libraryStatus.write({ agent: body.actingSubject, work: basis.work,
          status: body.status, titleKey: basis.title, startedOn: body.startedOn, finishedOn: body.finishedOn,
          expectedVersion: body.expectedVersion, idempotencyKey });
        return Response.json(result, { headers: privateHeaders });
      } catch (error) {
        if (error instanceof InvalidLibraryStatus || error instanceof StaleLibraryStatus
          || error instanceof LibraryStatusConflict) return failure(error);
        return commandError(error);
      }
    })
    .get('/v1/me/shelves', { query: t.Object({ actingSubject: readId,
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
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
      query: t.Object({ actingSubject: readId, sort: shelfSort, order: shelfOrder,
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
        cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) },
      { additionalProperties: false }), response: { 200: statusShelf, ...workReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library is unavailable');
      try {
        if (!await reader(request, query.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library is unavailable');
        const budget = new ShelfCandidateBudget();
        return Response.json(await workRead(work, request, query,
          session => readStatusShelf(session, query.actingSubject, work.libraryStatus!, params.status, query, budget)),
        { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .get('/v1/agents/:id/shelves', { params: t.Object({ id: readUuid }),
      query: t.Object(readQuery, { additionalProperties: false }),
      response: { 200: publicShelves, ...workReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      try {
        const agent = `https://rezics.com/id/${params.id}`;
        return await publicShelfResponse(work, request, query, agent,
          (session, budget) => readPublicShelves(session, agent, work.libraryStatus!, budget));
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
        const items = await workRead(work, request, query, async session =>
          work.libraryStatus!.privateReviews(query.actingSubject,
            [...new Set(await resolveLibraryWorks(session, works))]));
        return Response.json({ items }, { headers: privateHeaders });
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
        const canonical = await workRead(work, request, { actingSubject: body.actingSubject },async session => {
          const target = await resolveLibraryWork(session, workId);
          await readWorkBasis(session,target); return target;
        });
        return Response.json(await work.libraryStatus.putPrivateReview({ agent: body.actingSubject, work: canonical,
          text: body.text, language: body.language, spoiler: body.spoiler,
          expectedVersion: body.expectedVersion, idempotencyKey }), { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .get('/v1/me/reading-stats', {
      query: t.Object({ actingSubject: readId, year: t.Numeric({ minimum: 1900, maximum: 2100 }) },
        { additionalProperties: false }), response: { 200: readingStats, ...errors },
    }, async ({ request, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      try {
        const principal = await reader(request, query.actingSubject);
        if (!principal) return problem(403, 'reader_library_denied', 'Reader library unavailable');
        const result = await readRichReadingYear(work, request, principal, query.actingSubject, query.year);
        if (!await reader(request, query.actingSubject)) return problem(403, 'reader_library_denied', 'Reader library unavailable');
        return Response.json(result, { headers: privateHeaders });
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
      query: t.Object({ ...pageQuery, sort: publicShelfSort, order: shelfOrder }, { additionalProperties: false }),
      response: { 200: publicStatusShelf, ...workReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.libraryStatus) return problem(503, 'reader_library_unavailable', 'Reader library unavailable');
      try {
        const agent = `https://rezics.com/id/${params.id}`;
        return await publicShelfResponse(work, request, query, agent,
          (session, budget) => readPublicStatusShelf(session, agent, work.libraryStatus!, params.status, query, budget));
      } catch (error) { return failure(error); }
    });
}
