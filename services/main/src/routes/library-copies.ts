import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { copyChanges, copyState, LIBRARY_RECORD_COST, InvalidLibraryRecord, LibraryRecordConflict,
  LibraryRecordDenied, LibraryRecordMissing, StaleLibraryRecord, resolveCopyRelease, resolveLibraryParty,
  type LibraryParty } from '../modules/library/copies.ts';
import { loanDirection, loanState, loanStatus } from '../modules/library/loans.ts';
import { libraryParty, libraryTime } from '../modules/library/copies.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const closed = { additionalProperties: false };
const command = { actingSubject: readId, expectedVersion: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }) };
const pageQuery = { actingSubject: readId, limit: t.Optional(t.Integer({ minimum: 1, maximum: LIBRARY_RECORD_COST.page })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) };
const copyResult = t.Object({ ...copyState.properties, replayed: t.Boolean() }, closed);
const loanView = t.Object({ ...loanState.properties, state: loanStatus }, closed);
const loanResult = t.Object({ ...loanView.properties, replayed: t.Boolean() }, closed);
const errors = { ...workReadProblems, 409: problemResult(409) };
const privateHeaders = { 'cache-control': 'private, no-store' };

export const openApiOperations = {
  '/v1/works/{id}/copies': { get: { bearer: true, exposure: 'public' } },
  '/v1/me/library-copies': { post: { bearer: true, idempotencyKey: true, exposure: 'public' } },
  '/v1/me/library-copies/{id}': {
    patch: { bearer: true, idempotencyKey: true, exposure: 'public' },
    delete: { bearer: true, idempotencyKey: true, exposure: 'public' },
  },
  '/v1/me/library-loans': {
    get: { bearer: true, exposure: 'public' }, post: { bearer: true, idempotencyKey: true, exposure: 'public' },
  },
  '/v1/me/library-loans/{id}/extend': { post: { bearer: true, idempotencyKey: true, exposure: 'public' } },
  '/v1/me/library-loans/{id}/return': { post: { bearer: true, idempotencyKey: true, exposure: 'public' } },
} as const;

function failure(error: unknown): Response {
  if (error instanceof InvalidLibraryRecord) return problem(400, 'invalid_library_record', error.message);
  if (error instanceof LibraryRecordDenied) return problem(403, 'library_record_denied', error.message);
  if (error instanceof LibraryRecordMissing) return problem(404, 'library_record_unavailable', error.message);
  if (error instanceof StaleLibraryRecord) return problem(409, 'stale_library_record', error.message);
  if (error instanceof LibraryRecordConflict) return problem(409, 'library_record_conflict', error.message);
  if (error && typeof error === 'object' && 'code' in error && ['55P03', '57014', '40P01'].includes(String(error.code))) {
    return problem(503, 'library_record_unavailable', 'Library is busy; retry with the same Idempotency-Key');
  }
  return workReadError(error);
}

export function libraryCopiesRoutes(deps: MainWorkDependencies) {
  const own = async (request: Request, agent: string) => {
    const principal = await deps.account.verify(request, ['work:read']);
    if (!await deps.access.canReadAsBaselineMember?.(principal, agent)) {
      throw new LibraryRecordDenied('Copies and loans are private to your own Person');
    }
  };
  const unavailable = () => problem(503, 'library_record_unavailable', 'Copies and loans are unavailable');
  const checkParty = (request: Request, agent: string) => async (party: LibraryParty) => {
    if (party.kind === 'person') await workRead(deps, request, { actingSubject: agent }, session => resolveLibraryParty(session, party));
  };
  return new Elysia()
    .get('/v1/works/:id/copies', { params: t.Object({ id: readUuid }), query: t.Object(pageQuery, closed),
      response: { 200: t.Object({ items: t.Array(copyState, { maxItems: LIBRARY_RECORD_COST.page }),
        nextCursor: t.Nullable(t.String()), complete: t.Boolean() }, closed), ...errors },
    }, async ({ request, params, query }) => {
      if (!deps.libraryCopies) return unavailable();
      try {
        await own(request, query.actingSubject);
        const value = await deps.libraryCopies.page(query.actingSubject, `https://rezics.com/id/${params.id}`, query);
        await own(request, query.actingSubject);
        return Response.json({ ...value, complete: value.nextCursor === null }, { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .post('/v1/me/library-copies', { body: t.Object({ ...command, release: readId, ...copyChanges }, closed),
      response: { 201: copyResult, ...errors },
    }, async ({ request, body }) => {
      if (!deps.libraryCopies) return unavailable();
      try {
        await own(request, body.actingSubject);
        const { actingSubject, expectedVersion, release, ...changes } = body;
        const result = await deps.libraryCopies.write({ agent: actingSubject, expectedVersion, release, changes,
          idempotencyKey: request.headers.get('idempotency-key') ?? '' },
        () => workRead(deps, request, { actingSubject }, session => resolveCopyRelease(session, release)),
        () => own(request, actingSubject), checkParty(request, actingSubject));
        return Response.json(result, { status: 201, headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .patch('/v1/me/library-copies/:id', { params: t.Object({ id: readUuid }),
      body: t.Object({ ...command, ...copyChanges }, closed), response: { 200: copyResult, ...errors },
    }, async ({ request, params, body }) => {
      if (!deps.libraryCopies) return unavailable();
      try {
        await own(request, body.actingSubject);
        const { actingSubject, expectedVersion, ...changes } = body;
        const result = await deps.libraryCopies.write({ agent: actingSubject, expectedVersion, changes,
          id: `https://rezics.com/id/${params.id}`, idempotencyKey: request.headers.get('idempotency-key') ?? '' },
        async () => { throw new InvalidLibraryRecord('Copy identity cannot change'); }, () => own(request, actingSubject), checkParty(request, actingSubject));
        return Response.json(result, { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .delete('/v1/me/library-copies/:id', { params: t.Object({ id: readUuid }), body: t.Object(command, closed),
      response: { 200: copyResult, ...errors },
    }, async ({ request, params, body }) => {
      if (!deps.libraryCopies) return unavailable();
      try {
        await own(request, body.actingSubject);
        const result = await deps.libraryCopies.write({ agent: body.actingSubject, expectedVersion: body.expectedVersion,
          id: `https://rezics.com/id/${params.id}`, changes: {}, remove: true, idempotencyKey: request.headers.get('idempotency-key') ?? '' },
        async () => { throw new InvalidLibraryRecord('Copy identity cannot change'); }, () => own(request, body.actingSubject));
        return Response.json(result, { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .get('/v1/me/library-loans', { query: t.Object({ ...pageQuery,
      state: t.Optional(t.Union([t.Literal('active'), t.Literal('overdue'), t.Literal('returned')])) }, closed),
      response: { 200: t.Object({ items: t.Array(loanView, { maxItems: LIBRARY_RECORD_COST.page }),
        nextCursor: t.Nullable(t.String()), complete: t.Boolean() }, closed), ...errors },
    }, async ({ request, query }) => {
      if (!deps.libraryLoans) return unavailable();
      try {
        await own(request, query.actingSubject);
        const result = await deps.libraryLoans.page(query.actingSubject, query);
        await own(request, query.actingSubject);
        return Response.json({ ...result, complete: result.nextCursor === null }, { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .post('/v1/me/library-loans', { body: t.Object({ ...command, copy: readId, direction: loanDirection,
      counterparty: libraryParty, startedAt: libraryTime, dueAt: libraryTime }, closed), response: { 201: loanResult, ...errors },
    }, async ({ request, body }) => {
      if (!deps.libraryLoans) return unavailable();
      try {
        await own(request, body.actingSubject);
        const { actingSubject, ...input } = body;
        const result = await deps.libraryLoans.write({ ...input, operation: 'open', agent: actingSubject,
          idempotencyKey: request.headers.get('idempotency-key') ?? '' }, () => own(request, actingSubject), checkParty(request, actingSubject));
        return Response.json(result, { status: 201, headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .post('/v1/me/library-loans/:id/extend', { params: t.Object({ id: readUuid }),
      body: t.Object({ ...command, dueAt: libraryTime }, closed), response: { 200: loanResult, ...errors },
    }, async ({ request, params, body }) => {
      if (!deps.libraryLoans) return unavailable();
      try {
        await own(request, body.actingSubject);
        const result = await deps.libraryLoans.write({ operation: 'extend', agent: body.actingSubject,
          expectedVersion: body.expectedVersion, dueAt: body.dueAt, id: `https://rezics.com/id/${params.id}`,
          idempotencyKey: request.headers.get('idempotency-key') ?? '' }, () => own(request, body.actingSubject));
        return Response.json(result, { headers: privateHeaders });
      } catch (error) { return failure(error); }
    })
    .post('/v1/me/library-loans/:id/return', { params: t.Object({ id: readUuid }), body: t.Object(command, closed),
      response: { 200: loanResult, ...errors },
    }, async ({ request, params, body }) => {
      if (!deps.libraryLoans) return unavailable();
      try {
        await own(request, body.actingSubject);
        const result = await deps.libraryLoans.write({ operation: 'return', agent: body.actingSubject,
          expectedVersion: body.expectedVersion, id: `https://rezics.com/id/${params.id}`,
          idempotencyKey: request.headers.get('idempotency-key') ?? '' }, () => own(request, body.actingSubject));
        return Response.json(result, { headers: privateHeaders });
      } catch (error) { return failure(error); }
    });
}
